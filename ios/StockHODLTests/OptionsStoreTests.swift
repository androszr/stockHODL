import Foundation
import Testing

@testable import StockHODL

private final class FakeOptionsServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var writes: [(method: String, path: String, body: Data?)] = []
    private(set) var payloadCalls = 0
    private(set) var seriesCalls = 0
    private(set) var seriesQueries: [String] = []

    var payload: OptionsPayload = LiveFixture.optionsPayload()
    var payloadFails = false
    var seriesFails = false
    var writeStatus = 200

    func transport() -> APIClient.Transport {
        { [self] request in
            let url = request.url!
            let path = url.path()
            let method = request.httpMethod ?? "GET"

            if method != "GET" {
                let status = lock.withLock { () -> Int in
                    writes.append((method: method, path: path, body: request.httpBody))
                    return writeStatus
                }
                let body = status == 200
                    ? Data(#"{"ok":true}"#.utf8)
                    : Data(#"{"error":"nope"}"#.utf8)
                return (body, Self.response(url, status))
            }

            if path.contains("/series/options") {
                let fails = lock.withLock { () -> Bool in
                    seriesCalls += 1
                    seriesQueries.append(url.query() ?? "")
                    return seriesFails
                }
                if fails { throw URLError(.notConnectedToInternet) }
                let series = SeriesPayload(
                    anchorDate: nil,
                    estimatedFrom: nil,
                    excludedSymbols: [],
                    partialDays: 0,
                    points: []
                )
                return (try JSONEncoder().encode(series), Self.response(url, 200))
            }

            let (fails, payload) = lock.withLock { () -> (Bool, OptionsPayload) in
                payloadCalls += 1
                return (payloadFails, self.payload)
            }
            if fails { throw URLError(.notConnectedToInternet) }
            return (try JSONEncoder().encode(payload), Self.response(url, 200))
        }
    }

    private static func response(_ url: URL, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

@MainActor
private func makeStore(
    _ server: FakeOptionsServer,
    token: String? = "t",
    cache: FakePayloadCache<OptionsPayload> = FakePayloadCache<OptionsPayload>(),
    seriesCaches: FakePayloadCacheFamily<SeriesPayload> = FakePayloadCacheFamily<SeriesPayload>(),
    connected: Bool = true,
    pollInterval: Duration = OptionsStore.pollInterval,
    defaults: UserDefaults = UserDefaults(suiteName: "test.\(UUID().uuidString)") ?? .standard,
    now: @escaping @MainActor () -> Date = Date.init
) -> OptionsStore {
    OptionsStore(
        client: OptionsClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        // In memory, never the real Caches directory — see `FakeCaches`.
        cache: cache,
        makeSeriesCache: seriesCaches.make(),
        tokenProvider: { token },
        isConnected: { connected },
        // Injected only so a test can watch the gate close and reopen without
        // waiting a real minute; production always gets the 60 s static.
        pollInterval: pollInterval,
        // A throwaway domain per store: tapping a range remembers it, and the
        // standard suite would carry that into the next test's first request.
        defaults: defaults,
        now: now
    )
}

private func emptySeries() -> SeriesPayload {
    SeriesPayload(anchorDate: nil, estimatedFrom: nil, excludedSymbols: [], partialDays: 0, points: [])
}

@Suite("Options store")
@MainActor
struct OptionsStoreTests {
    @Test("the payload loads and the cards come through")
    func loads() async throws {
        let server = FakeOptionsServer()
        let store = makeStore(server)

        await store.refresh()

        #expect(server.payloadCalls == 1)
        #expect(store.visibleItems.count == 1)
        #expect(store.errorMessage == nil)
    }

    /// The web's hide rule, verbatim: expired contracts are out of the list
    /// AND out of the total by default, and the toggle moves both together.
    @Test("expired contracts are hidden by default, and the summary follows the list")
    func expiredHiddenByDefault() async {
        let server = FakeOptionsServer()
        server.payload = LiveFixture.optionsPayload(items: [
            LiveFixture.optionCard(key: "live", ticker: "live"),
            LiveFixture.optionCard(key: "dead", ticker: "dead", expired: true, daysToExpiry: -3),
        ])
        let store = makeStore(server)
        await store.refresh()

        #expect(store.visibleItems.map(\.key) == ["live"])
        #expect(store.expiredCount == 1)
        // The summary describing the VISIBLE set, not the whole book.
        #expect(store.visibleSummary?.totalValue == server.payload.summary.totalValue)

        store.showExpired = true
        #expect(store.visibleItems.count == 2)
        #expect(store.visibleSummary?.totalValue == server.payload.allSummary.totalValue)
    }

    /// Contracts exist but every one is hidden — the screen must say so in
    /// words rather than show an empty grid under a live market bar.
    @Test("a book of nothing but expired contracts reports all-hidden, not empty")
    func allHidden() async {
        let server = FakeOptionsServer()
        server.payload = LiveFixture.optionsPayload(items: [
            LiveFixture.optionCard(expired: true, daysToExpiry: -1),
        ])
        let store = makeStore(server)
        await store.refresh()

        #expect(store.visibleItems.isEmpty)
        #expect(store.allHidden)
        #expect(store.payload?.items.isEmpty == false)
    }

    @Test("an empty book is empty, not all-hidden")
    func emptyBook() async {
        let server = FakeOptionsServer()
        server.payload = LiveFixture.optionsPayload(items: [])
        let store = makeStore(server)
        await store.refresh()

        #expect(store.visibleItems.isEmpty)
        #expect(!store.allHidden)
    }

    @Test("two failures are offline; one is not")
    func offlineAfterTwo() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)
        await store.refresh()

        server.payloadFails = true
        await store.refresh()
        #expect(!store.isOffline)

        await store.refresh()
        #expect(store.isOffline)
    }

    /// A failure with cards already on screen is not an error state — the
    /// figures are stale, not gone.
    @Test("failing with data on screen keeps the data and sets no error")
    func failureWithDataIsNotAnError() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)
        await store.refresh()

        server.payloadFails = true
        await store.refresh()

        #expect(store.payload != nil)
        #expect(store.errorMessage == nil)
    }

    @Test("failing with nothing on screen is an error to retry")
    func failureWithNothingIsAnError() async {
        let server = FakeOptionsServer()
        server.payloadFails = true
        let store = makeStore(server)

        await store.refresh()

        #expect(store.payload == nil)
        // The fake fails with `.notConnectedToInternet`, and the screen now
        // says which of the two problems it actually is.
        #expect(store.errorMessage == LoadFailure.offline)
    }

    /// The chart is the OPTIONAL half: a book with no recorded marks is still
    /// a usable screen, so a series failure must not blank the cards.
    @Test("the series is fetched for the remembered range, on the five-range enum")
    func seriesUsesOptionsRanges() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)

        await store.loadSeries()

        #expect(server.seriesCalls == 1)
        let query = try! #require(server.seriesQueries.first)
        #expect(query.contains("range=1M"))
        // No `ticker` on the tab's own chart — that is the whole book.
        #expect(!query.contains("ticker="))
    }

    /// `range` moves on the tap; the points move when the fetch lands. The
    /// chart must read as loading in between, or the change row prints the
    /// previous window's numbers under the new window's name.
    @Test("a tapped range is loading until its own series lands")
    func rangeTapIsLoadingUntilItsSeriesLands() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)
        await store.loadSeries()
        #expect(store.seriesRange == .oneMonth)
        #expect(store.seriesState == .empty)

        // The `didSet` schedules its own fetch on a Task that cannot run
        // before this test suspends, so this is the in-flight moment.
        store.range = .oneYear

        #expect(store.series != nil)
        #expect(store.seriesState == .loading)

        await store.loadSeries()

        #expect(store.seriesRange == .oneYear)
        #expect(store.seriesState == .empty)
    }

    @Test("a failed refresh of the drawn range keeps it; a failed fetch for a new range does not")
    func seriesFailureRules() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)
        await store.loadSeries()

        // Same range, refresh misses: the old chart stands, under the stale
        // bar — blanking a real chart is the worse answer.
        server.seriesFails = true
        await store.loadSeries()
        #expect(store.series != nil)
        #expect(store.seriesState == .empty)

        // New range, fetch misses: the previous range's chart cannot stand
        // in for it, and a spinner that never ends would be a lie too.
        store.range = .all
        await store.loadSeries()
        #expect(store.series == nil)
        #expect(store.seriesState == .error)
        #expect(store.failedRange == .all)

        // The failure belongs to ALL. Tapping 6M is loading, not errored —
        // that tab has not failed anything yet.
        store.range = .sixMonth
        #expect(store.seriesState == .loading)
        #expect(store.failedRange == nil)

        // And it recovers.
        server.seriesFails = false
        await store.loadSeries()
        #expect(store.seriesRange == .sixMonth)
        #expect(store.seriesState == .empty)
    }

    /// The range is remembered on the TAP and the series is written when a
    /// fetch LANDS, so a single cache file could hold another range's points
    /// than the one defaults name. Per-range files make that impossible.
    @Test("a cached series is restored only from the remembered range's own file")
    func cachedSeriesIsPerRange() async {
        let server = FakeOptionsServer()
        let caches = FakePayloadCacheFamily<SeriesPayload>()
        let defaults = UserDefaults(suiteName: "test.\(UUID().uuidString)") ?? .standard
        OptionsChartRange.all.remember(in: defaults)
        // What a killed or failed fetch leaves behind: defaults say ALL, disk
        // holds only the 1M series.
        caches.cache(for: "options-series-1M").write(emptySeries())
        let store = makeStore(server, seriesCaches: caches, defaults: defaults)
        #expect(store.range == .all)

        await store.start()

        // The 1M file was not mistaken for ALL's: the store fetched instead.
        #expect(server.seriesCalls == 1)
        #expect(server.seriesQueries.first?.contains("range=ALL") == true)
        #expect(store.seriesRange == .all)
        #expect(store.seriesState == .empty)
        #expect(caches.cache(for: "options-series-ALL").writes == 1)
    }

    @Test("the remembered range's own cached series paints without a fetch")
    func cachedSeriesForRememberedRange() async {
        let server = FakeOptionsServer()
        let caches = FakePayloadCacheFamily<SeriesPayload>()
        caches.cache(for: "options-series-1M").write(emptySeries())
        let store = makeStore(server, seriesCaches: caches)

        await store.start()

        #expect(server.seriesCalls == 0)
        #expect(store.seriesRange == .oneMonth)
        #expect(store.seriesState == .empty)
    }

    @Test("a tapped range paints its own cached window at once, never another's")
    func tapPaintsOwnCache() async {
        let server = FakeOptionsServer()
        let caches = FakePayloadCacheFamily<SeriesPayload>()
        caches.cache(for: "options-series-1Y").write(emptySeries())
        let store = makeStore(server, seriesCaches: caches)
        await store.loadSeries()

        store.range = .oneYear
        // Before any fetch lands: the 1Y file is drawn as 1Y.
        #expect(store.seriesRange == .oneYear)
        #expect(store.seriesState == .empty)

        store.range = .all
        // No ALL file exists; the 1Y points are not shown under "all time".
        #expect(store.seriesState == .loading)
    }

    /// The OCC ticker, never the card key: a card can be a `ticker#rowId`
    /// group, which matches no row on the server.
    @Test("a contract's own series is addressed by ticker, not by card key")
    func contractSeriesUsesTicker() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)

        _ = await store.contractSeries(ticker: "O:AAPL260904C00220000", range: .sixMonth)

        let query = try! #require(server.seriesQueries.first)
        #expect(query.contains("ticker=O"))
        #expect(query.contains("range=6M"))
    }

    // MARK: - The poll gate

    /// `pollingResumesAtMs` is non-nil only while EVERY session is shut. A
    /// phone in a pocket over a weekend must issue nothing.
    @Test("a closed market with a future resume instant stops the poll")
    func closedMarketDoesNotPoll() async {
        let server = FakeOptionsServer()
        let future = Int(Date().timeIntervalSince1970 * 1000) + 3_600_000
        server.payload = LiveFixture.optionsPayload(status: .closed, resumesAtMs: future)
        let store = makeStore(server)

        await store.start()
        let after = server.payloadCalls

        // `start` refreshes once and then must arm nothing.
        try? await Task.sleep(for: .milliseconds(80))
        #expect(server.payloadCalls == after)
    }

    @Test("backgrounding cancels the poll")
    func backgroundingStops() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)
        await store.start()

        store.scenePhaseChanged(toActive: false)
        let after = server.payloadCalls

        try? await Task.sleep(for: .milliseconds(80))
        #expect(server.payloadCalls == after)
    }

    /// The bug this pins: the pump used to `return` at the closed-market gate
    /// and `resumePump()` used to refuse to arm at one, so with everything
    /// shut no loop existed and only a scene-phase or connectivity event could
    /// start one. A phone left on the desk overnight showed the previous close
    /// on the Dashboard's options row and on the Options tab all through the
    /// next trading day — and called it fresh, because the last fetch really
    /// had succeeded.
    @Test("a foregrounded store wakes itself when the market gate opens between ticks")
    func gateReopeningRevivesThePump() async {
        let server = FakeOptionsServer()
        // The gate's clock is the test's, not the machine's: it stands still
        // while the gate is meant to be shut and moves only when the test
        // opens it. The old version raced a real sleep against a real resume
        // instant, and on a loaded simulator the sleep overshot the open.
        let clock = FakeGateClock(seconds: 1_000)
        server.payload = LiveFixture.optionsPayload(status: .closed, resumesAtMs: 1_010_000)
        let store = makeStore(server, pollInterval: .milliseconds(20), now: { clock.now() })

        await store.start()
        #expect(server.payloadCalls == 1)

        // While the gate stays shut, ticks pass and not one of them costs a
        // request. Waited on as ticks OBSERVED (gate checks), never as time.
        let readsAtStart = clock.reads
        await until(timeout: .seconds(30)) { clock.reads >= readsAtStart + 3 }
        #expect(clock.reads >= readsAtStart + 3)
        #expect(server.payloadCalls == 1)

        // Past the resume instant, with NO scene-phase and NO connectivity
        // event: the loop's own next tick is what asks.
        clock.seconds = 1_010
        await until(timeout: .seconds(30)) { server.payloadCalls > 1 }
        #expect(server.payloadCalls > 1)

        // Stop the pump. Its payload's resume instant is now in the past, so
        // the gate stays open and the loop would keep fetching on its 20 ms
        // tick for the rest of the test process — underneath every slower
        // test's timing assertion.
        store.scenePhaseChanged(toActive: false)
    }

    /// The smaller instance of the same class: `refresh()` used to arm the
    /// pump only inside its `do`, so a first fetch that failed left the
    /// section frozen with no retry until the app was backgrounded and
    /// reopened.
    @Test("a first fetch that fails still leaves a pump armed")
    func failedFirstFetchStillArmsThePump() async {
        let server = FakeOptionsServer()
        server.payloadFails = true
        let store = makeStore(server, pollInterval: .milliseconds(40))

        await store.start()
        #expect(server.payloadCalls == 1)

        // `Backoff` widens the interval after consecutive failures, so the
        // wait is generous by construction: one failure, then success. It
        // returns the moment the retry lands.
        server.payloadFails = false
        await until(timeout: .seconds(30)) { server.payloadCalls > 1 }
        #expect(server.payloadCalls > 1)

        // Same reason as the gate test: a 40 ms pump must not outlive its own
        // test.
        store.scenePhaseChanged(toActive: false)
    }

    /// What the Dashboard's new caption binds to. A SwiftUI body is not unit
    /// testable here, so this pins the INPUT: a payload restored from disk is
    /// not `.fresh`, and `StaleLabel` yields a sentence for it — so
    /// `StaleCaption` has something to draw.
    @Test("a cached options payload is unconfirmed and yields a staleness sentence")
    func cachedPayloadIsUnconfirmed() async {
        let server = FakeOptionsServer()
        server.payloadFails = true
        let cache = FakePayloadCache<OptionsPayload>(
            seed: LiveFixture.optionsPayload(),
            capturedAt: Date().addingTimeInterval(-3600)
        )
        let store = makeStore(server, cache: cache)

        await store.start()

        #expect(store.payload != nil)
        #expect(store.freshness != .fresh)
        #expect(StaleLabel.label(for: store.freshness) != nil)

        store.scenePhaseChanged(toActive: false)
    }

    // MARK: - Writes

    /// Removal addresses a LOT, never a card — a card can stand for several
    /// purchases, and removing "the card" would delete one the user did not
    /// name.
    @Test("remove addresses the lot id")
    func removeAddressesALot() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)

        await store.remove(lotID: "11111111-1111-4111-8111-111111111111")

        let write = try! #require(server.writes.first)
        #expect(write.method == "DELETE")
        #expect(write.path == "/api/mobile/v1/options/11111111-1111-4111-8111-111111111111")
    }

    @Test("a failed write surfaces the server's own message")
    func writeFailureSurfaces() async {
        let server = FakeOptionsServer()
        server.writeStatus = 400
        let store = makeStore(server)

        let ok = await store.update(
            OptionEditRequest(
                id: "11111111-1111-4111-8111-111111111111",
                quantity: "2",
                entryPrice: "3.5",
                tradeDate: "2026-08-10",
                fees: "0"
            )
        )

        #expect(!ok)
        #expect(store.errorMessage != nil)
    }

    @Test("purge leaves nothing of the account behind")
    func purgeClears() async {
        let server = FakeOptionsServer()
        let store = makeStore(server)
        await store.start()

        store.purge()

        #expect(store.payload == nil)
        #expect(store.series == nil)
        #expect(store.visibleItems.isEmpty)
    }
}
