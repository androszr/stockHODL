import Foundation
import Testing

@testable import StockHODL

private final class FakeWatchServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var writes: [(method: String, path: String)] = []
    private(set) var itemCalls = 0
    private(set) var quoteCalls = 0

    var items: [WatchedItem] = [LiveFixture.watched()]
    var payload: WatchlistPayload = LiveFixture.watchPayload()
    var itemsFail = false
    var quotesFail = false
    var writeStatus = 200

    func transport() -> APIClient.Transport {
        { [self] request in
            let url = request.url!
            let path = url.path()
            let method = request.httpMethod ?? "GET"

            if method != "GET" {
                let status = lock.withLock { () -> Int in
                    writes.append((method: method, path: path))
                    return writeStatus
                }
                let body = status == 200
                    ? Data(#"{"ok":true}"#.utf8)
                    : Data(#"{"message":"nope"}"#.utf8)
                return (body, Self.response(url, status))
            }

            if path.hasSuffix("/quotes") {
                let (fails, payload) = lock.withLock { () -> (Bool, WatchlistPayload) in
                    quoteCalls += 1
                    return (quotesFail, self.payload)
                }
                if fails { throw URLError(.timedOut) }
                return (try JSONEncoder().encode(payload), Self.response(url, 200))
            }

            let (fails, items) = lock.withLock { () -> (Bool, [WatchedItem]) in
                itemCalls += 1
                return (itemsFail, self.items)
            }
            if fails { throw URLError(.notConnectedToInternet) }
            return (try JSONEncoder().encode(WatchlistResponse(items: items)), Self.response(url, 200))
        }
    }

    private static func response(_ url: URL, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

@MainActor
private func makeStore(
    _ server: FakeWatchServer,
    token: String? = "t",
    cache: FakePayloadCache<CachedWatchlist> = FakePayloadCache<CachedWatchlist>(),
    connected: Bool = true
) -> WatchlistStore {
    WatchlistStore(
        client: WatchlistClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        // In memory, never the real Caches directory — see `FakeCaches`.
        cache: cache,
        tokenProvider: { token },
        isConnected: { connected }
    )
}

@Suite("Watchlist store")
@MainActor
struct WatchlistStoreTests {
    @Test("membership and quotes are fetched together and matched by id")
    func loadsAndMatches() async throws {
        let server = FakeWatchServer()
        let store = makeStore(server)

        await store.refresh()

        #expect(server.itemCalls == 1)
        #expect(server.quoteCalls == 1)
        let item = try #require(store.items.first)
        #expect(store.figures(for: item)?.price == "182,40 USD")
    }

    @Test("a failed quote fetch still leaves a usable list")
    func quotesAreOptional() async {
        let server = FakeWatchServer()
        server.quotesFail = true
        let store = makeStore(server)

        await store.refresh()

        // A list of tickers with no figures is still a screen. Blanking it
        // because the vendor is having a bad minute is the wrong trade.
        #expect(store.items.count == 1)
        #expect(store.errorMessage == nil)
        #expect(store.live == nil)
    }

    @Test("no quote for a row is a dash, never a zero")
    func missingFiguresAreNil() async throws {
        let server = FakeWatchServer()
        server.items = [LiveFixture.watched(instrumentId: "i9", symbol: "ZZZZ")]
        let store = makeStore(server)

        await store.refresh()

        let item = try #require(store.items.first)
        // The payload has no entry for i9, so the tile has nothing to paint —
        // and "0,00" would be a price the market never printed.
        #expect(store.figures(for: item) == nil)
    }

    @Test("two failures are offline; one is not")
    func offlineNeedsTwo() async {
        let server = FakeWatchServer()
        let store = makeStore(server)
        await store.refresh()

        server.itemsFail = true
        await store.refresh()
        #expect(!store.isOffline)

        await store.refresh()
        #expect(store.isOffline)
    }

    @Test("adding a match posts the instrument fields and reloads")
    func addPosts() async {
        let server = FakeWatchServer()
        let store = makeStore(server)

        await store.add(LiveFixture.match(symbol: "MSFT"))

        #expect(server.writes.map(\.method) == ["POST"])
        // The reload is what makes the new tile appear — the POST answers
        // `{ ok: true }` and nothing else.
        #expect(server.itemCalls == 1)
    }

    @Test("a match with no currency is refused rather than guessed at")
    func unmappedCurrencyRefused() async {
        let server = FakeWatchServer()
        let store = makeStore(server)

        await store.add(LiveFixture.match(currency: nil))

        // Guessing USD would bind the symbol permanently — `instruments` is
        // global and first-write-wins.
        #expect(server.writes.isEmpty)
        #expect(store.errorMessage?.contains("missing a currency") == true)
    }

    @Test("removing something already gone still clears the row")
    func removeStale() async throws {
        let server = FakeWatchServer()
        let store = makeStore(server)
        await store.refresh()
        server.writeStatus = 404

        await store.remove(try #require(store.items.first))

        // Leaving a row that cannot be removed is worse than removing one that
        // was already gone.
        #expect(store.items.isEmpty)
    }

    @Test("purge clears everything the account put on screen")
    func purge() async {
        let server = FakeWatchServer()
        let store = makeStore(server)
        await store.refresh()

        store.purge()

        #expect(store.items.isEmpty)
        #expect(store.live == nil)
    }

    @Test("no token means no request at all")
    func withoutTokenDoesNothing() async {
        let server = FakeWatchServer()
        let store = makeStore(server, token: nil)

        await store.refresh()

        #expect(server.itemCalls == 0)
        #expect(server.quoteCalls == 0)
    }
}

@Suite("Watchlist add request")
struct WatchlistAddRequestTests {
    @Test("built from a confident match")
    func fromMatch() throws {
        let body = try #require(WatchlistAddRequest(LiveFixture.match()))

        #expect(body.symbol == "AAPL")
        #expect(body.exchange == "NASDAQ")
        #expect(body.currency == .usd)
    }

    @Test("refused when the server was not confident about the currency")
    func refusesUnmapped() {
        #expect(WatchlistAddRequest(LiveFixture.match(currency: nil)) == nil)
    }

    @Test("bounds match the shared instrument rules")
    func bounds() {
        // Same trims and lengths as `transactionInputSchema`, because both
        // paths mint an instrument through `resolveOrCreateInstrument`.
        #expect(WatchlistAddRequest(LiveFixture.match(symbol: String(repeating: "A", count: 21))) == nil)
        #expect(WatchlistAddRequest(LiveFixture.match(name: "")) == nil)
        #expect(WatchlistAddRequest(LiveFixture.match(exchange: "   ")) == nil)
    }
}

@Suite("Watchlist offline")
@MainActor
struct WatchlistOfflineTests {
    @Test("a cold start paints the cached list and admits it is unconfirmed")
    func cachedListPaints() async {
        let server = FakeWatchServer()
        server.itemsFail = true
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        let cache = FakePayloadCache(
            seed: CachedWatchlist(items: [LiveFixture.watched()], quotes: nil),
            capturedAt: taken
        )
        let store = makeStore(server, cache: cache)

        await store.start()

        #expect(!store.items.isEmpty)
        #expect(store.errorMessage == nil, "there is a list on screen; nothing to apologise for")
        #expect(store.freshness == .stale(since: taken))
    }

    @Test("a successful refresh writes the list and its quotes together")
    func refreshWritesCache() async {
        let server = FakeWatchServer()
        let cache = FakePayloadCache<CachedWatchlist>()
        let store = makeStore(server, cache: cache)

        await store.refresh()

        let cached = try! #require(cache.read())
        #expect(!cached.value.items.isEmpty)
    }
}
