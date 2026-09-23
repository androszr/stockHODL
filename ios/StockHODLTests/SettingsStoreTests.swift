import Foundation
import Testing

@testable import StockHODL

private final class FakeSettingsServer: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls = 0

    var status = 200
    var response = SettingsResponse(
        lastPriceFetchedAtMs: 1_760_000_000_000,
        marketData: .ok,
        recoveryMode: false
    )

    func transport() -> APIClient.Transport {
        { [self] request in
            let (status, payload): (Int, Data) = try lock.withLock {
                calls += 1
                return self.status >= 400
                    ? (self.status, Data(#"{"error":"nope"}"#.utf8))
                    : (200, try JSONEncoder().encode(self.response))
            }
            let http = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!
            return (payload, http)
        }
    }
}

@MainActor
private func makeStore(server: FakeSettingsServer, token: String? = "signed.token") -> SettingsStore {
    let config = AppConfig(baseURL: URL(string: "https://example.test")!)
    return SettingsStore(
        client: SettingsClient(api: APIClient(config: config, transport: server.transport())),
        tokenProvider: { token }
    )
}

@Suite("Settings store")
@MainActor
struct SettingsStoreTests {
    @Test("loads the verdict and the last fetch instant")
    func loads() async {
        let server = FakeSettingsServer()
        let store = makeStore(server: server)

        await store.load()

        #expect(store.response?.marketData == .ok)
        #expect(store.response?.lastPriceFetchedAtMs == 1_760_000_000_000)
        #expect(store.errorMessage == nil)
    }

    @Test("recovery mode arrives from the SERVER, because the phone cannot know")
    func recoveryMode() async {
        let server = FakeSettingsServer()
        server.response = SettingsResponse(
            lastPriceFetchedAtMs: nil,
            marketData: .unauthorized,
            recoveryMode: true
        )
        let store = makeStore(server: server)

        await store.load()

        // While this is on, a password is enough to reach the account. A phone
        // that could not surface it would leave the user with no way to learn.
        #expect(store.response?.recoveryMode == true)
        // A never-written quote cache is null, not epoch zero.
        #expect(store.response?.lastPriceFetchedAtMs == nil)
    }

    @Test("a failed check says so rather than reporting a healthy feed")
    func failure() async {
        let server = FakeSettingsServer()
        server.status = 500
        let store = makeStore(server: server)

        await store.load()

        #expect(store.response == nil)
        #expect(store.errorMessage == SettingsStore.genericError)
    }

    @Test("no token means no vendor probe")
    func withoutAToken() async {
        let server = FakeSettingsServer()
        let store = makeStore(server: server, token: nil)

        await store.load()

        #expect(server.calls == 0)
    }

    @Test("purge drops the verdict with everything else derived from the account")
    func purges() async {
        let server = FakeSettingsServer()
        let store = makeStore(server: server)
        await store.load()

        store.purge()

        #expect(store.response == nil)
    }
}

@Suite("Market data verdicts")
struct MarketDataHealthTests {
    @Test("every verdict has words, so the dot is never the only signal")
    func everyVerdictSpeaks() {
        for verdict in [MarketDataHealth.ok, .unauthorized, .unreachable] {
            #expect(!verdict.title.isEmpty)
            #expect(!verdict.detail.isEmpty)
        }
        #expect(MarketDataHealth.ok.title == "Working")
        #expect(MarketDataHealth.unauthorized.title == "Key rejected")
        #expect(MarketDataHealth.unreachable.title == "Unreachable")
    }

    @Test("a temporary outage is not painted as a dead key")
    func tokensDistinguishTheTwoFailures() {
        #expect(MarketDataHealth.ok.token == Tokens.gain)
        #expect(MarketDataHealth.unauthorized.token == Tokens.loss)
        // "The vendor had a bad minute" is not the same claim as "this key will
        // never work again", and the colour must not say it is.
        #expect(MarketDataHealth.unreachable.token == Tokens.textMuted)
    }

    @Test("no verdict mentions a key or a vendor URL")
    func neverLeaksTheKey() {
        for verdict in [MarketDataHealth.ok, .unauthorized, .unreachable] {
            let text = (verdict.title + verdict.detail).lowercased()
            #expect(!text.contains("http"))
            #expect(!text.contains("api key"))
        }
    }
}
