import Foundation
import Testing

@testable import StockHODL

// MARK: - Doubles

/// The Keychain, minus the Keychain. The real store needs an entitled, signed
/// process, which is precisely why the decisions about it — store on success,
/// purge on sign-out, purge on a rejected token — are tested here instead of
/// being taken on faith.
private final class FakeTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    private(set) var writes = 0
    private(set) var clears = 0

    init(initial: String? = nil) {
        value = initial
    }

    func read() throws -> String? { lock.withLock { value } }

    func write(_ token: String) throws {
        lock.withLock {
            value = token
            writes += 1
        }
    }

    func clear() throws {
        lock.withLock {
            value = nil
            clears += 1
        }
    }
}

@MainActor
private final class FakePasskeys: PasskeyAsserting {
    var result: Result<RawAssertion, Error>
    private(set) var lastRelyingPartyID: String?
    private(set) var lastChallenge: Data?
    private(set) var lastAllowed: [Data] = []

    init(result: Result<RawAssertion, Error> = .success(.stub)) {
        self.result = result
    }

    func assert(
        relyingPartyID: String,
        challenge: Data,
        allowedCredentials: [Data]
    ) async throws -> RawAssertion {
        lastRelyingPartyID = relyingPartyID
        lastChallenge = challenge
        lastAllowed = allowedCredentials
        return try result.get()
    }
}

extension RawAssertion {
    fileprivate static let stub = RawAssertion(
        credentialID: Data([0x01, 0x02, 0x03, 0x04]),
        clientDataJSON: Data("{\"type\":\"webauthn.get\"}".utf8),
        authenticatorData: Data([0xAA]),
        signature: Data([0xBB]),
        userHandle: nil
    )
}

/// A scripted server. Routes on path, records what it was sent, and answers
/// exactly what Better Auth answers — including the `set-auth-token` header,
/// whose absence is a distinct failure the store must not swallow.
private final class FakeServer: @unchecked Sendable {
    struct Reply {
        var status: Int = 200
        var headers: [String: String] = [:]
        var body: Data = Data("{}".utf8)
    }

    private let lock = NSLock()
    private var replies: [String: Reply] = [:]
    private(set) var paths: [String] = []
    private(set) var bodies: [String: Data] = [:]
    private(set) var cookieHeaders: [String: String] = [:]
    private(set) var authorizations: [String: String] = [:]

    func on(_ path: String, _ reply: Reply) {
        lock.withLock { replies[path] = reply }
    }

    var transport: APIClient.Transport {
        { [self] request in
            let path = request.url?.path() ?? ""
            let reply: Reply = lock.withLock {
                paths.append(path)
                bodies[path] = request.httpBody
                cookieHeaders[path] = request.value(forHTTPHeaderField: "Cookie")
                authorizations[path] = request.value(forHTTPHeaderField: "Authorization")
                return replies[path] ?? Reply(status: 404)
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: reply.status,
                httpVersion: "HTTP/1.1",
                headerFields: reply.headers
            )!
            return (reply.body, response)
        }
    }

    func hit(_ path: String) -> Bool { lock.withLock { paths.contains(path) } }
    func cookie(_ path: String) -> String? { lock.withLock { cookieHeaders[path] ?? nil } }
    func authorization(_ path: String) -> String? { lock.withLock { authorizations[path] ?? nil } }
}

// MARK: - Fixtures

private enum Fixture {
    static let optionsPath = "/api/auth/passkey/generate-authenticate-options"
    static let verifyPath = "/api/auth/passkey/verify-authentication"
    static let signInEmailPath = "/api/auth/sign-in/email"
    static let sessionPath = "/api/auth/get-session"
    static let signOutPath = "/api/auth/sign-out"

    static let config = AppConfig(baseURL: URL(string: "https://sawa-finance.vercel.app")!)

    static let user = Data("""
    { "session": { "id": "s1" },
      "user": { "id": "u1", "email": "owner@example.com", "name": "Owner" } }
    """.utf8)

    static let options = Data("""
    { "challenge": "AQIDBA", "rpId": "sawa-finance.vercel.app",
      "allowCredentials": [{ "id": "BQYHCA" }] }
    """.utf8)

    static func server(
        verifyHeaders: [String: String] = ["set-auth-token": "payload.signature"]
    ) -> FakeServer {
        let server = FakeServer()
        server.on(optionsPath, .init(
            headers: ["Set-Cookie": "better-auth-passkey=chal; Path=/; HttpOnly"],
            body: options
        ))
        server.on(verifyPath, .init(headers: verifyHeaders, body: user))
        server.on(sessionPath, .init(body: user))
        server.on(signOutPath, .init(body: Data(#"{"success":true}"#.utf8)))
        return server
    }
}

@MainActor
private func makeStore(
    server: FakeServer,
    tokens: FakeTokenStore,
    passkeys: FakePasskeys = FakePasskeys(),
    users: any SessionUserCaching = InMemorySessionUserCache()
) -> AuthStore {
    AuthStore(
        auth: AuthClient(api: APIClient(config: Fixture.config, transport: server.transport)),
        tokens: tokens,
        passkeys: passkeys,
        relyingPartyID: Fixture.config.relyingPartyID,
        users: users
    )
}

/// A store whose every request dies in transport — the tunnel, the cold
/// morning, the relaunch iOS did while the phone was in a pocket.
@MainActor
private func makeOfflineStore(
    tokens: FakeTokenStore,
    users: any SessionUserCaching = InMemorySessionUserCache()
) -> AuthStore {
    AuthStore(
        auth: AuthClient(api: APIClient(config: Fixture.config) { _ in
            throw URLError(.notConnectedToInternet)
        }),
        tokens: tokens,
        passkeys: FakePasskeys(),
        relyingPartyID: Fixture.config.relyingPartyID,
        users: users
    )
}

private let rememberedUser = SessionUser(id: "u1", email: "owner@example.com", name: nil)

// MARK: - Tests

@Suite("Auth flow")
@MainActor
struct AuthFlowTests {
    // MARK: Sign in

    @Test("a full ceremony stores the signed token and lands signed in")
    func happyPath() async throws {
        let server = Fixture.server()
        let tokens = FakeTokenStore()
        let passkeys = FakePasskeys()
        let store = makeStore(server: server, tokens: tokens, passkeys: passkeys)

        await store.signIn()

        #expect(store.state == .signedIn(SessionUser(id: "u1", email: "owner@example.com", name: nil)))
        #expect(try tokens.read() == "payload.signature")
        #expect(store.errorMessage == nil)
    }

    @Test("carries the challenge cookie from the options call into the verify call")
    func forwardsChallengeCookie() async throws {
        let server = Fixture.server()
        let store = makeStore(server: server, tokens: FakeTokenStore())

        await store.signIn()

        // Without this the plugin cannot find the challenge it issued and
        // answers "challenge not found" — the single most confusing failure in
        // this whole ceremony, because it sounds like a timeout.
        #expect(server.cookie(Fixture.verifyPath) == "better-auth-passkey=chal")
    }

    @Test("asks the authenticator for the relying party and credentials the server named")
    func usesServerOptions() async throws {
        let server = Fixture.server()
        let passkeys = FakePasskeys()
        let store = makeStore(server: server, tokens: FakeTokenStore(), passkeys: passkeys)

        await store.signIn()

        #expect(passkeys.lastRelyingPartyID == "sawa-finance.vercel.app")
        #expect(passkeys.lastChallenge == Data([0x01, 0x02, 0x03, 0x04]))
        #expect(passkeys.lastAllowed == [Data([0x05, 0x06, 0x07, 0x08])])
    }

    @Test("a verify response with no set-auth-token stores nothing")
    func strippedTokenHeader() async throws {
        // This is what a request that failed to declare itself native looks
        // like from the client's side: a 200 with a session that the phone can
        // never use. Storing an empty string here would produce an app that
        // looks signed in and 401s on everything.
        let server = Fixture.server(verifyHeaders: [:])
        let tokens = FakeTokenStore()
        let store = makeStore(server: server, tokens: tokens)

        await store.signIn()

        #expect(store.state == .signedOut)
        #expect(store.errorMessage == AuthStore.genericError)
        #expect(try tokens.read() == nil)
    }

    @Test("a cancelled sheet is not an error")
    func cancellation() async throws {
        let server = Fixture.server()
        let store = makeStore(
            server: server,
            tokens: FakeTokenStore(),
            passkeys: FakePasskeys(result: .failure(PasskeyError.cancelled))
        )

        await store.signIn()

        #expect(store.state == .signedOut)
        // The user closed the sheet. A red banner for that is the app telling
        // them off for changing their mind.
        #expect(store.errorMessage == nil)
        #expect(!server.hit(Fixture.verifyPath))
    }

    @Test("a rejected assertion says the same thing as any other failure")
    func genericError() async throws {
        let server = Fixture.server()
        server.on(Fixture.verifyPath, .init(
            status: 401,
            body: Data(#"{"code":"PASSKEY_NOT_FOUND","message":"Passkey not found"}"#.utf8)
        ))
        let store = makeStore(server: server, tokens: FakeTokenStore())

        await store.signIn()

        // Same stance as the web form: never let the message distinguish "no
        // such credential" from "wrong credential".
        #expect(store.errorMessage == AuthStore.genericError)
        #expect(store.state == .signedOut)
    }

    @Test("a challenge that is not base64url never reaches the authenticator")
    func badChallenge() async throws {
        let server = Fixture.server()
        server.on(Fixture.optionsPath, .init(body: Data(#"{"challenge":"!!!","rpId":"x.test"}"#.utf8)))
        let passkeys = FakePasskeys()
        let store = makeStore(server: server, tokens: FakeTokenStore(), passkeys: passkeys)

        await store.signIn()

        #expect(passkeys.lastChallenge == nil)
        #expect(store.errorMessage == AuthStore.genericError)
    }

    // MARK: Password (emergency)

    @Test("password sign-in stores the signed token and lands signed in")
    func passwordHappyPath() async throws {
        let server = Fixture.server()
        server.on(Fixture.signInEmailPath, .init(
            headers: ["set-auth-token": "payload.signature"],
            body: Fixture.user
        ))
        let tokens = FakeTokenStore()
        let store = makeStore(server: server, tokens: tokens)

        await store.signInWithPassword(email: "owner@example.com", password: "temp-password-16")

        #expect(store.state == .signedIn(SessionUser(id: "u1", email: "owner@example.com", name: nil)))
        #expect(try tokens.read() == "payload.signature")
        #expect(store.errorMessage == nil)
        // Native-client Origin + header already come from APIClient; this
        // just proves we posted the typed email and password, not a hardcoded
        // allowlist address.
        let body = server.bodies[Fixture.signInEmailPath].flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: String]
        }
        #expect(body?["email"] == "owner@example.com")
        #expect(body?["password"] == "temp-password-16")
    }

    @Test("a password response with no set-auth-token stores nothing")
    func passwordStrippedTokenHeader() async throws {
        let server = Fixture.server()
        server.on(Fixture.signInEmailPath, .init(headers: [:], body: Fixture.user))
        let tokens = FakeTokenStore()
        let store = makeStore(server: server, tokens: tokens)

        await store.signInWithPassword(email: "owner@example.com", password: "temp-password-16")

        #expect(store.state == .signedOut)
        #expect(store.errorMessage == AuthStore.genericError)
        #expect(try tokens.read() == nil)
    }

    @Test("a password refusal says the same thing as any other failure")
    func passwordRefusal() async throws {
        let server = Fixture.server()
        server.on(Fixture.signInEmailPath, .init(
            status: 403,
            body: Data(#"{"message":"Registration is closed."}"#.utf8)
        ))
        let tokens = FakeTokenStore()
        let store = makeStore(server: server, tokens: tokens)

        await store.signInWithPassword(email: "not-the-user@example.com", password: "nope")

        // Allowlist refusal and disabled-password both collapse here. Showing
        // "Registration is closed." would let an enumerator distinguish.
        #expect(store.errorMessage == AuthStore.genericError)
        #expect(store.state == .signedOut)
        #expect(try tokens.read() == nil)
    }

    // MARK: Restore

    @Test("no stored token means signed out without a network call")
    func restoreWithoutToken() async {
        let server = Fixture.server()
        let store = makeStore(server: server, tokens: FakeTokenStore())

        await store.restore()

        #expect(store.state == .signedOut)
        #expect(!server.hit(Fixture.sessionPath))
    }

    @Test("a stored token is checked against the server, not trusted")
    func restoreVerifies() async throws {
        let server = Fixture.server()
        let store = makeStore(server: server, tokens: FakeTokenStore(initial: "payload.signature"))

        await store.restore()

        #expect(store.state == .signedIn(SessionUser(id: "u1", email: "owner@example.com", name: nil)))
        #expect(server.authorization(Fixture.sessionPath) == "Bearer payload.signature")
    }

    @Test("a token the server no longer knows is purged")
    func restorePurgesDeadToken() async throws {
        let server = Fixture.server()
        // Better Auth answers 200 with a JSON `null` body for an unknown
        // session. A bare status check would read that as success and leave the
        // app permanently 'signed in' to nothing.
        server.on(Fixture.sessionPath, .init(body: Data("null".utf8)))
        let tokens = FakeTokenStore(initial: "payload.signature")
        let store = makeStore(server: server, tokens: tokens)

        await store.restore()

        #expect(store.state == .signedOut)
        #expect(try tokens.read() == nil)
    }

    @Test("an unreachable server on a first launch has nothing to show")
    func restoreKeepsTokenOffline() async throws {
        let tokens = FakeTokenStore(initial: "payload.signature")
        let store = makeOfflineStore(tokens: tokens)

        await store.restore()

        // No remembered user, so there is genuinely nothing to draw — but the
        // token survives, so the next launch on a working connection costs no
        // Face ID. Purging on a tunnel would teach the user the app logs
        // itself out at random.
        #expect(store.state == .signedOut)
        #expect(try tokens.read() == "payload.signature")
    }

    @Test("an unreachable server keeps the user who was already signed in")
    func restoreStaysSignedInOffline() async throws {
        // The bug this exists to keep fixed. Off the debugger iOS reclaims the
        // app constantly, so a launch on a bad connection is an ordinary
        // morning — and it used to land on the sign-in screen while a valid
        // token sat in the Keychain and a full snapshot sat in the App Group
        // container. `LiveStore` then paints that snapshot under its
        // "Data from HH:MM" bar, which is the honest rendering of "I could
        // not ask".
        let tokens = FakeTokenStore(initial: "payload.signature")
        let store = makeOfflineStore(
            tokens: tokens,
            users: InMemorySessionUserCache(user: rememberedUser)
        )

        await store.restore()

        #expect(store.state == .signedIn(rememberedUser))
        #expect(try tokens.read() == "payload.signature")
    }

    @Test("a server that fell over is not a rejection either")
    func restoreStaysSignedInOnServerError() async {
        let server = Fixture.server()
        server.on(Fixture.sessionPath, .init(status: 500))
        let store = makeStore(
            server: server,
            tokens: FakeTokenStore(initial: "payload.signature"),
            users: InMemorySessionUserCache(user: rememberedUser)
        )

        await store.restore()

        // A cold function that died says nothing about this session. Treating
        // it as a rejection would sign the user out every time the platform
        // hiccupped.
        #expect(store.state == .signedIn(rememberedUser))
    }

    @Test("a rejected token forgets the user as well as the token")
    func restoreForgetsRejectedUser() async throws {
        let server = Fixture.server()
        server.on(Fixture.sessionPath, .init(body: Data("null".utf8)))
        let users = InMemorySessionUserCache(user: rememberedUser)
        let store = makeStore(
            server: server,
            tokens: FakeTokenStore(initial: "payload.signature"),
            users: users
        )

        await store.restore()

        // The server ANSWERED. That is the one reply that proves something,
        // and a remembered identity must not survive it — otherwise the next
        // offline launch would sign the app back in to a dead session.
        #expect(store.state == .signedOut)
        #expect(users.read() == nil)
    }

    @Test("signing in remembers the user, signing out forgets them")
    func signInRemembersUser() async throws {
        let server = Fixture.server()
        let users = InMemorySessionUserCache()
        let store = makeStore(server: server, tokens: FakeTokenStore(), users: users)

        await store.signIn()
        #expect(users.read()?.id == "u1")

        await store.signOut()
        #expect(users.read() == nil)
    }

    // MARK: Sign out

    @Test("revokes server side and purges locally")
    func signOut() async throws {
        let server = Fixture.server()
        let tokens = FakeTokenStore(initial: "payload.signature")
        let store = makeStore(server: server, tokens: tokens)

        await store.signOut()

        #expect(server.authorization(Fixture.signOutPath) == "Bearer payload.signature")
        #expect(try tokens.read() == nil)
        #expect(store.state == .signedOut)
    }

    @Test("purges locally even when the revoke fails")
    func signOutPurgesAnyway() async throws {
        let server = Fixture.server()
        server.on(Fixture.signOutPath, .init(status: 500))
        let tokens = FakeTokenStore(initial: "payload.signature")
        let store = makeStore(server: server, tokens: tokens)

        await store.signOut()

        // A user who taps sign out on a flaky connection must not be left
        // holding a live seven-day token. The server-side session then expires
        // on its own, which is the lesser problem by a wide margin.
        #expect(try tokens.read() == nil)
        #expect(store.state == .signedOut)
        #expect(tokens.clears == 1)
    }
}
