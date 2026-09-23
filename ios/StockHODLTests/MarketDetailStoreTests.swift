import Foundation
import Testing

@testable import StockHODL

/// A server for the market detail screen: one series door, scripted, with a
/// record of what was asked for — the `FakeInstrumentServer` arrangement
/// trimmed to the one read this store makes.
private final class FakeMarketSeriesServer: @unchecked Sendable {
    private let lock = NSLock()

    /// Every request, as `"<key>:<range>"`, in order.
    private(set) var requests: [String] = []
    var fails = false
    var points: [ChartPoint] = LiveFixture.series()
    /// Per-range answer delay, so a test can make an older request land
    /// after a newer one.
    var delayNs: [String: UInt64] = [:]

    func transport() -> APIClient.Transport {
        { [self] request in
            let url = request.url!
            let key = String(url.path().split(separator: "/").last ?? "")
            let range = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "range" }?.value ?? ""
            let (shouldFail, points, delay) = lock.withLock { () -> (Bool, [ChartPoint], UInt64) in
                requests.append("\(key):\(range)")
                return (fails, self.points, delayNs[range] ?? 0)
            }
            if delay > 0 { try await Task.sleep(nanoseconds: delay) }
            if shouldFail { throw URLError(.notConnectedToInternet) }
            let body = try JSONEncoder().encode(
                SeriesPayload(
                    anchorDate: "2021-09-21",
                    estimatedFrom: nil,
                    excludedSymbols: [],
                    partialDays: 0,
                    points: points
                )
            )
            return (
                body,
                HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
            )
        }
    }
}

@MainActor
private func makeStore(
    _ server: FakeMarketSeriesServer,
    key: MarketTileKey = .usdpln,
    token: String? = "t",
    range: ChartRange? = .oneDay,
    caches: FakePayloadCacheFamily<SeriesPayload> = FakePayloadCacheFamily<SeriesPayload>(),
    defaults: UserDefaults = UserDefaults(suiteName: "market-detail.\(UUID().uuidString)")!,
    connected: Bool = true
) -> MarketDetailStore {
    MarketDetailStore(
        key: key,
        client: MarketStripClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        // In memory, never the real Caches directory — see `FakeCaches`.
        makeSeriesCache: caches.make(),
        tokenProvider: { token },
        isConnected: { connected },
        range: range,
        defaults: defaults
    )
}

@Suite("Market detail store")
@MainActor
struct MarketDetailStoreTests {
    @Test("opens on the remembered range and asks for exactly that window")
    func opensOnRemembered() async {
        let server = FakeMarketSeriesServer()
        let defaults = UserDefaults(suiteName: "market-detail.\(UUID().uuidString)")!
        ChartRange.sixMonth.remember(in: defaults)
        let store = makeStore(server, key: .spy, range: nil, defaults: defaults)

        #expect(store.range == .sixMonth)
        await store.load()

        #expect(server.requests == ["SPY:6M"])
    }

    @Test("the series lands as ready, fresh, and the chart prints as a rate for the currency")
    func seriesLands() async {
        let server = FakeMarketSeriesServer()
        let store = makeStore(server)

        await store.load()

        #expect(store.seriesState == .ready)
        #expect(store.points.count == LiveFixture.series().count)
        #expect(store.freshness == .fresh)
        #expect(store.unit == .rate)
        #expect(makeStore(server, key: .dia).unit == .money)
        #expect(makeStore(server, key: .dia).currency == "USD")
    }

    @Test("an empty payload is an answer, not a failure")
    func emptyIsEmpty() async {
        let server = FakeMarketSeriesServer()
        server.points = []
        let store = makeStore(server)

        await store.load()

        #expect(store.seriesState == .empty)
    }

    @Test("a failure with nothing drawn is an error")
    func failureIsError() async {
        let server = FakeMarketSeriesServer()
        server.fails = true
        let store = makeStore(server)

        await store.load()

        #expect(store.seriesState == .error)
        #expect(store.points.isEmpty)
    }

    @Test("a failure over a drawn chart keeps the chart and goes stale")
    func failureKeepsChart() async {
        let server = FakeMarketSeriesServer()
        let store = makeStore(server)
        await store.load()
        #expect(store.seriesState == .ready)

        // Two failures, not one: a single miss over a healthy radio is noise
        // by `StaleState`'s rule, and only the second makes a verdict.
        server.fails = true
        await store.load()
        await store.load()

        #expect(store.seriesState == .ready)
        #expect(store.points.count == LiveFixture.series().count)
        #expect(store.freshness != .fresh)
    }

    @Test("a range switch refetches, and a stale in-flight answer for the old range is discarded")
    func rangeSwitchDiscardsStale() async {
        let server = FakeMarketSeriesServer()
        // 5D answers slowly; 1M answers at once. The 5D answer landing after
        // the 1M one must not repaint the 1M chart.
        server.delayNs = ["5D": 150_000_000]
        let store = makeStore(server)
        await store.load()

        store.range = .fiveDay
        await until { server.requests.count == 2 }
        #expect(store.seriesState == .loading)
        // Switch again while 5D is still in flight; 1M answers at once.
        store.range = .oneMonth
        await until { server.requests.count == 3 && store.seriesState == .ready }
        // Let the slow 5D answer arrive — and be discarded.
        server.points = []
        try? await Task.sleep(for: .milliseconds(250))

        #expect(server.requests == ["USDPLN:1D", "USDPLN:5D", "USDPLN:1M"])
        #expect(store.range == .oneMonth)
        #expect(store.seriesState == .ready)
        #expect(store.points.count == LiveFixture.series().count)
    }

    @Test("the disk cache key carries the tile key and the range")
    func cacheKeyed() async {
        let server = FakeMarketSeriesServer()
        let caches = FakePayloadCacheFamily<SeriesPayload>()
        let store = makeStore(server, key: .qqq, caches: caches)

        await store.load()
        store.range = .oneYear
        await until { server.requests.count == 2 }

        #expect(caches.keys.contains("QQQ-1D"))
        #expect(caches.keys.contains("QQQ-1Y"))
        #expect(caches.cache(for: "QQQ-1D").writes == 1)
    }

    @Test("a cached series paints before the network answers and is marked unconfirmed")
    func cachePaintsFirst() async {
        let server = FakeMarketSeriesServer()
        server.fails = true
        let caches = FakePayloadCacheFamily<SeriesPayload>()
        caches.cache(for: "USDPLN-1D").write(
            SeriesPayload(
                anchorDate: nil,
                estimatedFrom: nil,
                excludedSymbols: [],
                partialDays: 0,
                points: LiveFixture.series()
            ),
            at: Date().addingTimeInterval(-600)
        )
        let store = makeStore(server, caches: caches)

        await store.load()

        #expect(store.seriesState == .ready)
        #expect(store.freshness != .fresh)
    }

    @Test("no token means no request, and the screen does not hang on its spinner")
    func noToken() async {
        let server = FakeMarketSeriesServer()
        let store = makeStore(server, token: nil)

        await store.load()

        #expect(server.requests.isEmpty)
        #expect(store.seriesState == .error)
    }

    @Test("a range tap without a token settles on error rather than a spinner")
    func noTokenOnRangeSwitch() async {
        let server = FakeMarketSeriesServer()
        let store = makeStore(server, token: nil)
        await store.load()

        store.range = .fiveDay
        await until { store.seriesState == .error }

        #expect(server.requests.isEmpty)
        #expect(store.seriesState == .error)
    }
}
