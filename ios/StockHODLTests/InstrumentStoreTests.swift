import Foundation
import Testing

@testable import StockHODL

/// A server for the instrument screen: scripted answers, and a record of what
/// was asked for. `@unchecked Sendable` over a lock for the same reason
/// `FakeServer` in `LiveStoreTests` is — the transport closure is `@Sendable`
/// and the assertions want plain synchronous reads.
private final class FakeInstrumentServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var detailCalls = 0
    private(set) var rangesRequested: [String] = []

    /// Every watch write the screen made, by method — POST adds, DELETE
    /// removes.
    private(set) var watchCalls: [String] = []
    var watchStatus = 200
    /// What the detail says about membership, so a test can open on either
    /// state.
    var watched = false

    /// HTTP status for the detail call. 404 is the "not yours" answer.
    var detailStatus = 200
    var detailFails = false
    var seriesFails = false
    var seriesPoints: [ChartPoint] = LiveFixture.series()

    /// Price targets the detail carries, and the DELETE route over them.
    /// Each delete answers `targets` minus every id deleted so far — the real
    /// server's fresh list — after an optional per-id delay, so a test can
    /// make two in-flight deletes answer in either order.
    var targets: [PriceTarget] = []
    var targetDeleteDelayNs: [String: UInt64] = [:]
    private(set) var targetDeleteCalls: [String] = []

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path() ?? ""
            let isSeries = path.contains("/series/price/")
            let isWatchlist = path.contains("/watchlist")
            let isTargetDelete = path.contains("/price-targets/") && request.httpMethod == "DELETE"

            if isTargetDelete {
                let id = String(path.split(separator: "/").last ?? "")
                let (delay, remaining) = lock.withLock { () -> (UInt64, [PriceTarget]) in
                    targetDeleteCalls.append(id)
                    let gone = Set(targetDeleteCalls)
                    return (targetDeleteDelayNs[id] ?? 0, targets.filter { !gone.contains($0.id) })
                }
                if delay > 0 { try await Task.sleep(nanoseconds: delay) }
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (
                    try JSONEncoder().encode(PriceTargetsResponse(status: nil, targets: remaining)),
                    response
                )
            }

            if isWatchlist {
                let method = request.httpMethod ?? "GET"
                let status = lock.withLock { () -> Int in
                    watchCalls.append(method)
                    return watchStatus
                }
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (Data(#"{"ok":true}"#.utf8), response)
            }

            let (status, fails) = lock.withLock { () -> (Int, Bool) in
                if isSeries {
                    let range = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                        .queryItems?.first { $0.name == "range" }?.value
                    rangesRequested.append(range ?? "")
                    return (200, seriesFails)
                }
                detailCalls += 1
                return (detailStatus, detailFails)
            }

            if fails { throw URLError(.notConnectedToInternet) }

            let body: Data
            if isSeries {
                body = try JSONEncoder().encode(
                    SeriesPayload(
                        anchorDate: "2026-01-02",
                        estimatedFrom: nil,
                        excludedSymbols: [],
                        partialDays: 0,
                        points: lock.withLock { seriesPoints }
                    )
                )
            } else if status == 200 {
                body = try JSONEncoder().encode(
                    lock.withLock {
                        LiveFixture.instrument(watched: watched, priceTargets: targets)
                    }
                )
            } else {
                body = Data(#"{"error":"not found"}"#.utf8)
            }

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!
            return (body, response)
        }
    }
}

@MainActor
private func makeStore(
    server: FakeInstrumentServer,
    symbol: String = "AAPL",
    token: String? = "signed.token",
    range: ChartRange = .oneDay,
    seed: InstrumentSeed? = nil,
    cache: FakePayloadCache<InstrumentResponse> = FakePayloadCache<InstrumentResponse>(),
    seriesCaches: FakePayloadCacheFamily<SeriesPayload> = FakePayloadCacheFamily<SeriesPayload>(),
    connected: Bool = true
) -> InstrumentStore {
    let config = AppConfig(baseURL: URL(string: "https://example.test")!)
    let api = APIClient(config: config, transport: server.transport())
    return InstrumentStore(
        symbol: symbol,
        client: InstrumentClient(api: api),
        seed: seed,
        // In memory, never the real Caches directory — see `FakeCaches`.
        cache: cache,
        makeSeriesCache: seriesCaches.make(),
        // Same fake transport: the watch endpoints are routed by path inside
        // `FakeInstrumentServer`, so one server answers the whole screen.
        watchlist: WatchlistClient(api: api),
        tokenProvider: { token },
        isConnected: { connected },
        range: range,
        // A throwaway domain per store — see the note in `LiveStoreTests`.
        defaults: UserDefaults(suiteName: "test.\(UUID().uuidString)") ?? .standard
    )
}

@Suite("Instrument store")
@MainActor
struct InstrumentStoreTests {
    @Test("loads the detail and the series together")
    func loadsBoth() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server)

        await store.load()

        #expect(store.detail?.symbol == "AAPL")
        #expect(store.seriesState == .ready)
        #expect(server.rangesRequested == ["1D"])
        #expect(!store.isLoading)
    }

    @Test("a failed series does not blank out a correct header")
    func seriesFailureIsContained() async {
        let server = FakeInstrumentServer()
        server.seriesFails = true
        let store = makeStore(server: server)

        await store.load()

        // An empty chart above a correct position is a far better screen than
        // an error over both.
        #expect(store.detail != nil)
        #expect(store.errorMessage == nil)
        #expect(store.seriesState == .error)
    }

    @Test("an empty range is an answer, not a failure")
    func emptyIsNotError() async {
        let server = FakeInstrumentServer()
        server.seriesPoints = []
        let store = makeStore(server: server)

        await store.load()

        // "No data for this range" and "couldn't load" are different sentences
        // and only one of them invites a retry.
        #expect(store.seriesState == .empty)
    }

    @Test("a single point is not a line")
    func onePointIsEmpty() async {
        let server = FakeInstrumentServer()
        server.seriesPoints = Array(LiveFixture.series().prefix(1))
        let store = makeStore(server: server)

        await store.load()

        #expect(store.seriesState == .empty)
    }

    @Test("a 404 is a missing instrument, not an error to retry")
    func notFound() async {
        let server = FakeInstrumentServer()
        server.detailStatus = 404
        let store = makeStore(server: server)

        await store.load()

        // The server said this instrument is not one of yours. Asking again
        // will say the same, so no Try again button.
        #expect(store.isMissing)
        #expect(store.errorMessage == nil)
    }

    @Test("a transport failure with nothing on screen is an error")
    func transportFailure() async {
        let server = FakeInstrumentServer()
        server.detailFails = true
        let store = makeStore(server: server)

        await store.load()

        // The fake fails with `.notConnectedToInternet`, so the screen names
        // the network rather than blaming itself.
        #expect(store.errorMessage == LoadFailure.offline)
        #expect(!store.isMissing)
        #expect(!store.isLoading)
    }

    @Test("a cached detail paints before the network answers, and says it is unconfirmed")
    func cachedDetailPaints() async {
        let server = FakeInstrumentServer()
        server.detailFails = true
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        let cache = FakePayloadCache(seed: LiveFixture.instrument(), capturedAt: taken)
        let store = makeStore(server: server, cache: cache)

        await store.load()

        #expect(store.detail != nil)
        #expect(store.errorMessage == nil, "there is a screen; nothing to apologise for")
        #expect(store.freshness == .stale(since: taken))
    }

    @Test("a 404 clears the cached copy — the server has proved it is not ours")
    func missingClearsCache() async {
        let server = FakeInstrumentServer()
        server.detailStatus = 404
        let cache = FakePayloadCache(seed: LiveFixture.instrument())
        let store = makeStore(server: server, cache: cache)

        await store.load()

        #expect(store.isMissing)
        #expect(store.detail == nil)
        #expect(cache.read() == nil)
    }

    @Test("with no cache and no network, the seed draws a header instead of an error")
    func seedDrawsHeader() async {
        let server = FakeInstrumentServer()
        server.detailFails = true
        let seed = InstrumentSeed(
            symbol: "AAPL",
            displayName: "Apple Inc.",
            currency: .usd,
            price: "$189.12",
            dayPct: nil,
            cachedPrice: nil
        )
        let store = makeStore(server: server, seed: seed)

        await store.load()

        // The seed survives a failed load: it is what the screen draws.
        #expect(store.detail == nil)
        #expect(store.seed == seed)
    }

    @Test("the series is cached per range, so two ranges cannot overwrite each other")
    func seriesCachedPerRange() async {
        let server = FakeInstrumentServer()
        let caches = FakePayloadCacheFamily<SeriesPayload>()
        let store = makeStore(server: server, range: .oneDay, seriesCaches: caches)

        await store.load()

        #expect(caches.keys.contains("AAPL-1D"))
        #expect(!caches.keys.contains("AAPL-1Y"))
    }

    @Test("changing the range refetches only the series")
    func rangeChangeRefetchesSeries() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server)
        await store.load()

        store.range = .oneYear
        // The store starts the fetch in an unstructured task, so the test has
        // to wait for it. POLLING rather than one fixed sleep: a 50 ms sleep
        // passes on an idle machine and fails on a busy one, which is a test
        // that reports the load average rather than the code.
        await until { server.rangesRequested.count == 2 }

        #expect(server.rangesRequested == ["1D", "1Y"])
        // The detail did not move — nothing about a chart range changes what
        // the user owns.
        #expect(server.detailCalls == 1)
    }

    @Test("re-selecting the same range asks for nothing")
    func sameRangeIsNoop() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server)
        await store.load()

        store.range = .oneDay
        try? await Task.sleep(for: .milliseconds(50))

        #expect(server.rangesRequested == ["1D"])
    }

    @Test("the remembered range is what the screen opens on")
    func opensOnRemembered() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server, range: .sixMonth)

        await store.load()

        #expect(server.rangesRequested == ["6M"])
    }

    @Test("no token means no request at all")
    func withoutTokenDoesNothing() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server, token: nil)

        await store.load()

        #expect(server.detailCalls == 0)
        #expect(server.rangesRequested.isEmpty)
    }

    @Test("the chart plots the instrument's own currency, never PLN")
    func plotsItsOwnCurrency() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server)

        await store.load()

        // Converting a price series to PLN would draw the złoty's movements
        // into a line the user reads as the stock's.
        #expect(store.currency == "USD")
    }
}

@Suite("Request URLs")
struct RequestURLTests {
    private let base = URL(string: "https://example.test")!

    @Test("a query is assembled, not spliced into the path")
    func queryIsEncoded() {
        let url = APIClient.url(base: base, path: "/api/mobile/v1/series/price/AAPL", query: ["range": "1D"])
        // Splicing "?range=1D" into the path percent-encodes the "?" and gives
        // a 404 whose cause is invisible in the request line.
        #expect(url.absoluteString == "https://example.test/api/mobile/v1/series/price/AAPL?range=1D")
    }

    @Test("a symbol with a dot survives the path")
    func dottedSymbol() {
        let url = APIClient.url(base: base, path: "/api/mobile/v1/instrument/BRK.B", query: [:])
        #expect(url.absoluteString == "https://example.test/api/mobile/v1/instrument/BRK.B")
    }

    @Test("no query means no trailing question mark")
    func emptyQuery() {
        let url = APIClient.url(base: base, path: "/api/mobile/v1/live", query: [:])
        #expect(url.absoluteString == "https://example.test/api/mobile/v1/live")
    }
}

// MARK: - Watching

@Suite("Instrument watch control")
@MainActor
struct InstrumentWatchTests {
    @Test("the flag comes from the payload it already carries")
    func readsTheServerFlag() async {
        let server = FakeInstrumentServer()
        server.watched = true
        let store = makeStore(server: server)

        await store.load()

        // `watched` has always ridden in the payload — it just had no control.
        #expect(store.isWatched)
    }

    @Test("watching posts, and the control moves without waiting for a reload")
    func addsOptimistically() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server)
        await store.load()

        await store.toggleWatch()

        #expect(server.watchCalls == ["POST"])
        // The server's answer is already known: a successful POST means
        // watched. Waiting for a reload would make a one-bit toggle feel like
        // a form submission.
        #expect(store.isWatched)
    }

    @Test("unwatching deletes")
    func removes() async {
        let server = FakeInstrumentServer()
        server.watched = true
        let store = makeStore(server: server)
        await store.load()

        await store.toggleWatch()

        #expect(server.watchCalls == ["DELETE"])
        #expect(!store.isWatched)
    }

    @Test("a 404 on removal reflects reality instead of getting stuck")
    func removalOfAnAlreadyGoneRow() async {
        let server = FakeInstrumentServer()
        server.watched = true
        let store = makeStore(server: server)
        await store.load()
        server.watchStatus = 404

        await store.toggleWatch()

        // Removed from the web, or a second tap. Leaving the control "on"
        // would leave a button that can never be operated.
        #expect(!store.isWatched)
        #expect(store.errorMessage == nil)
    }

    @Test("a failed write leaves the control where it was and says so")
    func failedWrite() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server)
        await store.load()
        server.watchStatus = 500

        await store.toggleWatch()

        #expect(!store.isWatched)
        #expect(store.errorMessage != nil)
    }

    @Test("the next load re-states the flag rather than trusting the optimistic one")
    func reloadWins() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server)
        await store.load()
        await store.toggleWatch()
        #expect(store.isWatched)

        // The server still says "not watched" — as it would after the row was
        // removed from the web. The optimistic value must not outlive it.
        await store.load()

        #expect(!store.isWatched)
    }

    @Test("two overlapping deletes never bring a removed target back")
    func overlappingDeletes() async {
        let server = FakeInstrumentServer()
        let a = PriceTarget(
            createdAtMs: 1, direction: .up, hitAtMs: nil, id: "a", instrumentId: "i1", targetPrice: "200"
        )
        let b = PriceTarget(
            createdAtMs: 1, direction: .down, hitAtMs: nil, id: "b", instrumentId: "i1", targetPrice: "150"
        )
        server.targets = [a, b]
        // A is asked first, so the server's answer to it still lists B — and
        // that answer lands last. Adopting it as-is would resurrect B.
        server.targetDeleteDelayNs = ["a": 200_000_000]
        let store = makeStore(server: server)
        await store.load()
        #expect(store.priceTargets.map(\.id) == ["a", "b"])

        let first = Task { await store.deleteTarget(a) }
        // B is sent only once A's request has reached the server — the order
        // this test is about, awaited rather than guessed with a sleep.
        await until { server.targetDeleteCalls == ["a"] }
        await store.deleteTarget(b)
        #expect(store.priceTargets.isEmpty)
        await first.value

        #expect(server.targetDeleteCalls == ["a", "b"])
        #expect(store.priceTargets.isEmpty)
        #expect(store.deletingTargetIds.isEmpty)
    }

    @Test("without a watchlist client the screen still builds and the toggle is inert")
    func withoutAWatchlistClient() async {
        let config = AppConfig(baseURL: URL(string: "https://example.test")!)
        let server = FakeInstrumentServer()
        let store = InstrumentStore(
            symbol: "AAPL",
            client: InstrumentClient(api: APIClient(config: config, transport: server.transport())),
            tokenProvider: { "signed.token" },
            defaults: UserDefaults(suiteName: "test.\(UUID().uuidString)") ?? .standard
        )
        await store.load()

        await store.toggleWatch()

        // Every screen must stay constructible from fakes; a watch button is
        // not worth making that impossible.
        #expect(server.watchCalls.isEmpty)
    }

    @Test("no token fails the screen rather than hanging it on the spinner")
    func noTokenStopsLoading() async {
        let server = FakeInstrumentServer()
        let store = makeStore(server: server, token: nil)

        await store.load()

        // `isLoading` starts true, so an early return here used to leave the
        // pushed screen spinning with nothing on the way.
        #expect(!store.isLoading)
        #expect(store.errorMessage == InstrumentStore.genericError)
        #expect(server.detailCalls == 0)
    }
}
