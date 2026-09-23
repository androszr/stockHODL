import Foundation
import Testing

@testable import StockHODL

private final class FakeMarketStripServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var calls = 0

    var payload: MarketStripPayload = MarketStripFixture.payload()
    var fails = false

    func transport() -> APIClient.Transport {
        { [self] request in
            let url = request.url!
            let (shouldFail, payload) = lock.withLock { () -> (Bool, MarketStripPayload) in
                calls += 1
                return (fails, self.payload)
            }
            if shouldFail { throw URLError(.notConnectedToInternet) }
            return (
                try JSONEncoder().encode(payload),
                HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
            )
        }
    }
}

enum MarketStripFixture {
    static func tile(
        key: MarketTileKey = .spy,
        indexName: String = "S&P 500",
        proxySymbol: String = "SPY",
        last: String? = "645,32 USD",
        dayPct: LiveFigure? = LiveFixture.figure("+0,84%"),
        spark: [ChartPoint] = [point(t: 1, v: "640.10"), point(t: 2, v: "645.32")]
    ) -> IndexTile {
        IndexTile(
            dayPct: dayPct,
            indexName: indexName,
            key: key,
            last: last,
            proxySymbol: proxySymbol,
            spark: spark,
            trend: nil
        )
    }

    static func fx(
        last: String? = "3,7955",
        dayPct: LiveFigure? = LiveFixture.figure("+0,12%"),
        spark: [ChartPoint] = [point(t: 1, v: "3.7900"), point(t: 2, v: "3.7955")]
    ) -> CurrencyTile {
        CurrencyTile(
            caption: "PLN per 1 USD",
            dayPct: dayPct,
            key: .usdpln,
            last: last,
            pairLabel: "USD/PLN",
            spark: spark,
            trend: nil
        )
    }

    static func point(t: Int, v: String) -> ChartPoint {
        ChartPoint(h: nil, l: nil, o: nil, p: nil, r: nil, t: t, v: v)
    }

    static func payload(
        status: MarketStatus = .marketStatusOpen,
        resumesAtMs: Int? = nil,
        tiles: [IndexTile]? = nil,
        fx: CurrencyTile = fx()
    ) -> MarketStripPayload {
        MarketStripPayload(
            fx: fx,
            market: LiveFixture.market(status: status, resumesAtMs: resumesAtMs),
            tiles: tiles ?? [
                tile(),
                tile(key: .qqq, indexName: "Nasdaq", proxySymbol: "QQQ", last: "561,20 USD"),
                tile(
                    key: .dia,
                    indexName: "Dow",
                    proxySymbol: "DIA",
                    last: "444,10 USD",
                    dayPct: LiveFixture.figure("-0,31%", .loss)
                ),
            ]
        )
    }
}

@MainActor
private func makeStore(
    _ server: FakeMarketStripServer,
    token: String? = "t",
    cache: FakePayloadCache<MarketStripPayload> = FakePayloadCache<MarketStripPayload>(),
    connected: Bool = true,
    pollInterval: Duration = MarketStripStore.pollInterval,
    now: @escaping @MainActor () -> Date = Date.init
) -> MarketStripStore {
    MarketStripStore(
        client: MarketStripClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        // In memory, never the real Caches directory — see `FakeCaches`.
        cache: cache,
        tokenProvider: { token },
        isConnected: { connected },
        pollInterval: pollInterval,
        now: now
    )
}

@Suite("Market strip store")
@MainActor
struct MarketStripStoreTests {
    @Test("the payload decodes and all three tiles come through, in order")
    func decodes() async {
        let server = FakeMarketStripServer()
        let store = makeStore(server)

        await store.refresh()

        #expect(server.calls == 1)
        #expect(store.tiles.map(\.proxySymbol) == ["SPY", "QQQ", "DIA"])
        #expect(store.tiles.map(\.indexName) == ["S&P 500", "Nasdaq", "Dow"])
    }

    /// The disclosure is the contract: every tile names the fund its number
    /// came from, in every state the payload can be in.
    @Test("a tile with no quote still names its index and its proxy fund")
    func unquotedTileStillDiscloses() async throws {
        let server = FakeMarketStripServer()
        server.payload = MarketStripFixture.payload(tiles: [
            MarketStripFixture.tile(last: nil, dayPct: nil, spark: [])
        ])
        let store = makeStore(server)

        await store.refresh()

        let tile = try #require(store.tiles.first)
        #expect(tile.last == nil)
        #expect(tile.proxySymbol == "SPY")
        #expect(tile.indexName == "S&P 500")
    }

    // MARK: - The fourth tile and the detail header (2026-09-20)

    @Test("the USD/PLN tile decodes beside the three index tiles")
    func fxTileDecodes() async throws {
        let server = FakeMarketStripServer()
        let store = makeStore(server)

        await store.refresh()

        let fx = try #require(store.fx)
        #expect(fx.key == .usdpln)
        #expect(fx.pairLabel == "USD/PLN")
        #expect(fx.caption == "PLN per 1 USD")
        #expect(fx.last == "3,7955")
        #expect(fx.dayPct?.text == "+0,12%")
        #expect(store.tiles.count == 3)
        #expect(store.tiles.map(\.key) == [.spy, .qqq, .dia])
    }

    /// The seam the market detail screen's header is tested through: one
    /// lookup that answers either tile shape with its own disclosure.
    @Test("tile(for:) builds the header for an index key and for the currency key")
    func tileForKey() async throws {
        let server = FakeMarketStripServer()
        let store = makeStore(server)
        #expect(store.tile(for: .spy) == nil)

        await store.refresh()

        let spy = try #require(store.tile(for: .spy))
        #expect(spy.title == "S&P 500")
        #expect(spy.caption == "via SPY")
        #expect(spy.last == "645,32 USD")
        #expect(spy.dayPct?.direction == .gain)

        let dow = try #require(store.tile(for: .dia))
        #expect(dow.caption == "via DIA")
        #expect(dow.dayPct?.text == "-0,31%")

        let fx = try #require(store.tile(for: .usdpln))
        #expect(fx.title == "USD/PLN")
        #expect(fx.caption == "PLN per 1 USD")
        #expect(fx.last == "3,7955")
        #expect(fx.dayPct?.text == "+0,12%")
    }

    @Test("a degraded currency tile still names itself")
    func degradedFxStillDiscloses() async throws {
        let server = FakeMarketStripServer()
        server.payload = MarketStripFixture.payload(
            fx: MarketStripFixture.fx(last: nil, dayPct: nil, spark: [])
        )
        let store = makeStore(server)

        await store.refresh()

        let header = try #require(store.tile(for: .usdpln))
        #expect(header.last == nil)
        #expect(header.dayPct == nil)
        #expect(header.title == "USD/PLN")
        #expect(header.caption == "PLN per 1 USD")
    }

    // MARK: - The poll gate

    /// `pollingResumesAtMs` is non-nil only while EVERY session is shut. A
    /// phone in a pocket over a weekend must issue nothing at all.
    @Test("a closed market with a future resume instant stops the poll")
    func closedMarketDoesNotPoll() async {
        let server = FakeMarketStripServer()
        let future = Int(Date().timeIntervalSince1970 * 1000) + 3_600_000
        server.payload = MarketStripFixture.payload(status: .closed, resumesAtMs: future)
        let store = makeStore(server)

        await store.start()
        let after = server.calls

        // `start` refreshes once and must then arm nothing.
        try? await Task.sleep(for: .milliseconds(80))
        #expect(server.calls == after)
    }

    /// The bug this pins: the pump used to `return` at the closed-market gate,
    /// so the loop died and only a scene-phase or connectivity event could
    /// revive it. A phone left on the desk overnight showed yesterday's close
    /// all through the next trading day — and called it fresh, because the
    /// last fetch really had succeeded.
    @Test("a foregrounded store wakes itself when the market gate opens between ticks")
    func gateReopeningRevivesThePump() async {
        let server = FakeMarketStripServer()
        // The gate's clock is the test's, not the machine's: it stands still
        // while the gate is meant to be shut and moves only when the test
        // opens it. The old version raced a real sleep against a real resume
        // instant, and on a loaded simulator the sleep overshot the open.
        let clock = FakeGateClock(seconds: 1_000)
        server.payload = MarketStripFixture.payload(status: .closed, resumesAtMs: 1_010_000)
        let store = makeStore(server, pollInterval: .milliseconds(20), now: { clock.now() })

        await store.start()
        #expect(server.calls == 1)

        // While the gate stays shut, ticks pass and not one of them costs a
        // request. Waited on as ticks OBSERVED (gate checks), never as time.
        let readsAtStart = clock.reads
        await until(timeout: .seconds(30)) { clock.reads >= readsAtStart + 3 }
        #expect(clock.reads >= readsAtStart + 3)
        #expect(server.calls == 1)

        // Past the resume instant, with NO scene-phase and NO connectivity
        // event: the loop's own next tick is what asks.
        clock.seconds = 1_010
        await until(timeout: .seconds(30)) { server.calls > 1 }
        #expect(server.calls > 1)

        // Stop the pump. Its payload's resume instant is now in the past, so
        // the gate stays open and the loop would keep fetching on its 20 ms
        // tick for the rest of the test process — underneath every slower
        // test's timing assertion.
        store.scenePhaseChanged(toActive: false)
    }

    @Test("backgrounding cancels the poll")
    func backgroundingStopsThePump() async {
        let server = FakeMarketStripServer()
        let store = makeStore(server)

        await store.start()
        store.scenePhaseChanged(toActive: false)
        let after = server.calls

        try? await Task.sleep(for: .milliseconds(80))
        #expect(server.calls == after)
    }

    /// A store the Dashboard has never opened must not fetch because a train
    /// left a tunnel — the `hasStarted` gate every other store applies.
    @Test("an unopened store ignores a scene change and a regained radio")
    func coldStoreIgnoresFanOut() async {
        let server = FakeMarketStripServer()
        let store = makeStore(server)

        store.scenePhaseChanged(toActive: true)
        store.connectivityChanged(to: true)

        try? await Task.sleep(for: .milliseconds(50))
        #expect(server.calls == 0)
    }

    // MARK: - Cache and freshness

    /// The cold-launch lie this exists to prevent: a snapshot read from disk
    /// used to be indistinguishable from a fresh fetch, so a launch in a
    /// tunnel painted yesterday's market undisclosed.
    @Test("a cached strip paints at once and is marked unconfirmed until a fetch lands")
    func cachePaintIsUnconfirmed() async {
        let server = FakeMarketStripServer()
        server.fails = true
        let cache = FakePayloadCache<MarketStripPayload>(
            seed: MarketStripFixture.payload(),
            capturedAt: Date().addingTimeInterval(-3600)
        )
        let store = makeStore(server, cache: cache)

        await store.start()

        #expect(store.tiles.count == 3)
        #expect(store.freshness != .fresh)
        #expect(StaleLabel.label(for: store.freshness) != nil)
    }

    @Test("a successful fetch is fresh and is written to the cache")
    func successWritesCache() async {
        let server = FakeMarketStripServer()
        let cache = FakePayloadCache<MarketStripPayload>()
        let store = makeStore(server, cache: cache)

        await store.refresh()

        #expect(store.freshness == .fresh)
        #expect(cache.writes == 1)
        #expect(StaleLabel.label(for: store.freshness) == nil)
    }

    @Test("a failing client after a success ends in a stale verdict, keeping the tiles")
    func failureAfterSuccessGoesStale() async {
        let server = FakeMarketStripServer()
        let store = makeStore(server)

        await store.refresh()
        server.fails = true
        // Two consecutive failures are what makes a verdict over a
        // healthy-looking radio — `StaleState`'s rule, not this store's.
        await store.refresh()
        await store.refresh()

        #expect(store.tiles.count == 3)
        if case .stale = store.freshness {} else {
            Issue.record("expected a stale verdict, got \(store.freshness)")
        }
    }

    @Test("sign-out purges the tiles and the cache")
    func purgeClears() async {
        let server = FakeMarketStripServer()
        let cache = FakePayloadCache<MarketStripPayload>()
        let store = makeStore(server, cache: cache)

        await store.start()
        store.purge()

        #expect(store.tiles.isEmpty)
        #expect(cache.clears == 1)
        #expect(store.hasStarted == false)
    }
}
