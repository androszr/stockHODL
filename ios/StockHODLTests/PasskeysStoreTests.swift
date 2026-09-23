import Foundation
import Testing

@testable import StockHODL

/// A passkey server: a list it will answer with, a record of the deletes
/// it was asked for, and the registration ceremony. `@unchecked Sendable`
/// over a lock for the same reason every other fake here is.
private final class FakePasskeyServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var listCalls = 0
    private(set) var deleted: [String] = []
    private(set) var registerCalls = 0
    private(set) var verifyCalls = 0
    private(set) var verifyCookie: String?

    var items: [PasskeyItem] = [
        PasskeyFixture.item(id: "k1", name: "iPhone"),
        PasskeyFixture.item(id: "k2", name: "MacBook"),
    ]
    var canRemove = true

    /// The next DELETE answers this instead of 200. `nil` means success.
    var deleteFailure: (status: Int, body: String)?
    /// The next generate-register-options answers this instead of 200.
    var registerFailure: (status: Int, body: String)?
    /// The next verify-registration answers this instead of 200.
    var verifyFailure: (status: Int, body: String)?

    static let registerOptions = Data("""
    { "challenge": "AQIDBA",
      "rp": { "name": "StockHODL", "id": "sawa-finance.vercel.app" },
      "user": { "id": "BQYHCA", "name": "iPhone", "displayName": "Owner" } }
    """.utf8)

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path() ?? ""
            var headers: [String: String] = [:]
            var status = 200
            let body: Data

            if path.contains("/passkey/generate-register-options") {
                let failure = lock.withLock { () -> (status: Int, body: String)? in
                    registerCalls += 1
                    return registerFailure
                }
                if let failure {
                    status = failure.status
                    body = Data(failure.body.utf8)
                } else {
                    headers["Set-Cookie"] = "better-auth-passkey=chal; Path=/; HttpOnly"
                    body = Self.registerOptions
                }
            } else if path.contains("/passkey/verify-registration") {
                let failure = lock.withLock { () -> (status: Int, body: String)? in
                    verifyCalls += 1
                    verifyCookie = request.value(forHTTPHeaderField: "Cookie")
                    return verifyFailure
                }
                if let failure {
                    status = failure.status
                    body = Data(failure.body.utf8)
                } else {
                    body = Data(#"{"id":"k3"}"#.utf8)
                }
            } else if request.httpMethod == "DELETE" {
                let id = request.url?.lastPathComponent ?? ""
                let failure = lock.withLock { () -> (status: Int, body: String)? in
                    deleted.append(id)
                    return deleteFailure
                }
                if let failure {
                    status = failure.status
                    body = Data(failure.body.utf8)
                } else {
                    body = Data(#"{"ok":true}"#.utf8)
                }
            } else {
                let response = lock.withLock {
                    listCalls += 1
                    return PasskeysResponse(canRemove: canRemove, items: items)
                }
                body = try JSONEncoder().encode(response)
            }

            let http = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers.isEmpty ? nil : headers
            )!
            return (body, http)
        }
    }
}

@MainActor
private final class FakeRegistrar: PasskeyRegistering {
    var result: Result<RawRegistration, Error> = .success(.stub)

    func register(
        relyingPartyID: String,
        challenge: Data,
        userName: String,
        userID: Data,
        excludeCredentials: [Data]
    ) async throws -> RawRegistration {
        try result.get()
    }
}

extension RawRegistration {
    fileprivate static let stub = RawRegistration(
        credentialID: Data([0x01, 0x02, 0x03, 0x04]),
        clientDataJSON: Data("{\"type\":\"webauthn.create\"}".utf8),
        attestationObject: Data([0xAA])
    )
}

private enum PasskeyFixture {
    static func item(
        id: String,
        name: String? = "iPhone",
        deviceType: String = "multiDevice",
        backedUp: Bool = true,
        createdAtISO: String? = "2026-03-04T09:15:00.000Z"
    ) -> PasskeyItem {
        PasskeyItem(
            backedUp: backedUp,
            createdAtISO: createdAtISO,
            deviceType: deviceType,
            id: id,
            name: name
        )
    }
}

@MainActor
private func makeStore(
    _ server: FakePasskeyServer,
    token: String? = "signed.token"
) -> PasskeysStore {
    PasskeysStore(
        client: PasskeysClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        registrar: FakeRegistrar(),
        relyingPartyID: "example.test",
        tokenProvider: { token }
    )
}

@Suite("Passkeys store")
@MainActor
struct PasskeysStoreTests {
    @Test("the list loads with the server's own removal verdict")
    func loads() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)

        await store.load()

        #expect(store.items.count == 2)
        // Not derived from `items.count`: the never-the-last-one rule has one
        // implementation and it is on the server.
        #expect(store.canRemove)
        #expect(store.errorMessage == nil)
    }

    @Test("one key means the server forbids removal, whatever the count says")
    func singleKeyCannotBeRemoved() async {
        let server = FakePasskeyServer()
        server.items = [PasskeyFixture.item(id: "k1")]
        server.canRemove = false
        let store = makeStore(server)

        await store.load()

        #expect(!store.canRemove)
    }

    @Test("a removal reloads rather than dropping the row locally")
    func removeReloads() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)
        await store.load()

        // After this the server would answer canRemove: false — a local drop
        // would leave a swipe on screen that the server is certain to refuse.
        server.items = [PasskeyFixture.item(id: "k2", name: "MacBook")]
        server.canRemove = false

        await store.remove(PasskeyFixture.item(id: "k1"))

        #expect(server.deleted == ["k1"])
        #expect(server.listCalls == 2)
        #expect(store.items.count == 1)
        #expect(!store.canRemove)
    }

    @Test("the server's refusal is what the user reads, not a generic failure")
    func refusalKeepsItsSentence() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)
        await store.load()

        server.deleteFailure = (409, #"{"error":"This is your only passkey — add another before removing it."}"#)
        await store.remove(PasskeyFixture.item(id: "k1"))

        // "Could not remove that passkey" would send someone looking for a bug
        // that is not there. The route wrote a sentence; it survives the wire.
        #expect(store.errorMessage?.contains("only passkey") == true)
        // And the list is untouched — a failed delete removed nothing.
        #expect(store.items.count == 2)
    }

    @Test("a failure with no sentence still says something")
    func genericFailure() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)
        await store.load()

        server.deleteFailure = (500, "not json at all")
        await store.remove(PasskeyFixture.item(id: "k1"))

        #expect(store.errorMessage == PasskeysStore.removeError)
    }

    @Test("no token means no request at all")
    func withoutToken() async {
        let server = FakePasskeyServer()
        let store = makeStore(server, token: nil)

        await store.load()

        #expect(server.listCalls == 0)
        #expect(store.items.isEmpty)
    }

    @Test("enrolling a key reloads the list")
    func addReloads() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)
        await store.load()

        server.items = [
            PasskeyFixture.item(id: "k1", name: "iPhone"),
            PasskeyFixture.item(id: "k2", name: "MacBook"),
            PasskeyFixture.item(id: "k3", name: "iPhone"),
        ]
        server.canRemove = true

        await store.add(name: "iPhone")

        #expect(server.registerCalls == 1)
        #expect(server.verifyCalls == 1)
        #expect(server.verifyCookie == "better-auth-passkey=chal")
        #expect(server.listCalls == 2)
        #expect(store.items.count == 3)
        #expect(store.errorMessage == nil)
    }

    @Test("a failed enroll leaves the list untouched")
    func addFailureLeavesList() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)
        await store.load()

        server.verifyFailure = (400, #"{"message":"Failed to verify registration"}"#)
        await store.add(name: "iPhone")

        #expect(server.verifyCalls == 1)
        #expect(server.listCalls == 1)
        #expect(store.items.count == 2)
        #expect(store.errorMessage != nil)
    }

    @Test("a stale session asks to sign in again, not a generic add failure")
    func staleSessionOnAdd() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)
        await store.load()

        server.registerFailure = (403, #"{"message":"Session is not fresh","code":"SESSION_NOT_FRESH"}"#)
        await store.add(name: "iPhone")

        #expect(server.registerCalls == 1)
        #expect(server.verifyCalls == 0)
        #expect(store.items.count == 2)
        #expect(store.errorMessage == PasskeysStore.staleSessionError)
    }

    @Test("sign-out leaves nothing behind")
    func purge() async {
        let server = FakePasskeyServer()
        let store = makeStore(server)
        await store.load()

        store.purge()

        // The next account's profile must not open on the previous one's
        // devices, even for a frame.
        #expect(store.items.isEmpty)
        #expect(!store.canRemove)
    }
}

@Suite("Passkey row")
struct PasskeyRowTests {
    @Test("an unnamed key still says something a person can pick out")
    func unnamed() {
        #expect(PasskeyFixture.item(id: "k1", name: nil).displayName == "Unnamed passkey")
        #expect(PasskeyFixture.item(id: "k1", name: "  ").displayName == "Unnamed passkey")
    }

    @Test("the plugin's vocabulary never reaches the screen")
    func syncWording() {
        #expect(PasskeyFixture.item(id: "k1", deviceType: "multiDevice").syncDescription == "Synced")
        #expect(
            PasskeyFixture.item(id: "k1", deviceType: "singleDevice").syncDescription
                == "This device only"
        )
    }

    @Test("the subtitle drops the parts that do not exist")
    func subtitleOmits() {
        let bare = PasskeyFixture.item(
            id: "k1",
            deviceType: "singleDevice",
            backedUp: false,
            createdAtISO: nil
        )
        #expect(bare.subtitle == "This device only")
    }

    @Test("a fractional-seconds timestamp is parsed, not dropped")
    func parsesFractionalSeconds() {
        // `toISOString()` always emits milliseconds and the default
        // ISO8601DateFormatter rejects them — which would silently drop the
        // date from every row rather than fail loudly anywhere.
        let item = PasskeyFixture.item(id: "k1", createdAtISO: "2026-03-04T09:15:00.000Z")
        #expect(item.subtitle.contains("added"))
    }
}
