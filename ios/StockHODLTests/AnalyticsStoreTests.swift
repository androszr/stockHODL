import Foundation
import Testing

@testable import StockHODL

/// An analytics server. `@unchecked Sendable` over a lock, like every other
/// fake here.
private final class FakeAnalyticsServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var calls = 0
    private(set) var lastQuery: String?

    var response = AnalyticsFixture.response()
    var failure: Int?

    func transport() -> APIClient.Transport {
        { [self] request in
            let status = lock.withLock { () -> Int in
                calls += 1
                lastQuery = request.url?.query
                return failure ?? 200
            }
            let body = status == 200
                ? try JSONEncoder().encode(lock.withLock { response })
                : Data(#"{"error":"nope"}"#.utf8)
            let http = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!
            return (body, http)
        }
    }
}

private enum AnalyticsFixture {
    static let scopeID = "22222222-2222-4222-8222-222222222222"

    static func metric(
        value: String = "+12,34%",
        direction: Direction = .gain,
        note: String? = nil
    ) -> AnalyticsMetric {
        AnalyticsMetric(direction: direction, note: note, value: value)
    }

    static func slice(
        key: String = "AAPL",
        label: String = "AAPL",
        share: String = "40"
    ) -> AllocationSlice {
        AllocationSlice(
            colorVar: "var(--color-cat-1)",
            key: key,
            label: label,
            pct: "+40,00%",
            share: share,
            value: "10 000,00 zł"
        )
    }

    static func point(t: Int, v: String) -> ChartPoint {
        ChartPoint(h: nil, l: nil, o: nil, p: nil, r: nil, t: t, v: v)
    }

    static func response(
        scopeId: String? = scopeID,
        xirr: AnalyticsMetric = metric(),
        excluded: [ExcludedSymbol] = [
            ExcludedSymbol(reason: .noPriceHistory, symbol: "COLD"),
        ]
    ) -> AnalyticsResponse {
        AnalyticsResponse(
            benchmark: AnalyticsBenchmark(
                benchmark: [point(t: 1_704_067_200_000, v: "100"), point(t: 1_704_153_600_000, v: "102")],
                degradedReason: nil,
                portfolio: [point(t: 1_704_067_200_000, v: "100"), point(t: 1_704_153_600_000, v: "110.5")]
            ),
            breakdown: AnalyticsBreakdown(
                currency: [slice(key: "USD", label: "USD")],
                portfolio: [slice(key: scopeID, label: "Main")],
                sector: [slice(key: "Technology", label: "Technology")],
                ticker: [slice()]
            ),
            concentration: nil,
            excludedSymbols: excluded,
            inceptionDateISO: "2024-01-15",
            partialDays: 1,
            scopeId: scopeId,
            scopes: [AnalyticsScope(id: scopeID, name: "Main")],
            skippedDays: 2,
            targetDrift: nil,
            totalGain: "1 234,56 zł",
            totalGainDirection: .gain,
            totalValue: "10 000,00 zł",
            twrrAnnualized: metric(value: "+8,00%"),
            twrrCumulative: metric(value: "+20,00%"),
            xirr: xirr
        )
    }
}

@MainActor
private func makeStore(
    _ server: FakeAnalyticsServer,
    token: String? = "signed.token",
    caches: FakePayloadCacheFamily<AnalyticsResponse> = FakePayloadCacheFamily<AnalyticsResponse>(),
    connected: Bool = true
) -> AnalyticsStore {
    AnalyticsStore(
        client: AnalyticsClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        makeCache: caches.make(),
        tokenProvider: { token },
        isConnected: { connected }
    )
}

@Suite("Analytics store")
@MainActor
struct AnalyticsStoreTests {
    @Test("the payload loads with its disclosures intact")
    func loadsView() async {
        let server = FakeAnalyticsServer()
        let store = makeStore(server)

        await store.load()

        #expect(store.view?.xirr.value == "+12,34%")
        #expect(store.view?.xirr.direction == .gain)
        #expect(store.view?.breakdown.ticker.count == 1)
        #expect(store.view?.excludedSymbols.map(\.symbol) == ["COLD"])
        #expect(store.view?.benchmark.portfolio.count == 2)
        #expect(store.errorMessage == nil)
        // The server resolved the scope; the chip has to land on what arrived.
        #expect(store.selectedScopeID == AnalyticsFixture.scopeID)
    }

    @Test("a portfolio filter travels as p=, never as a client-side fold")
    func sendsScope() async {
        let server = FakeAnalyticsServer()
        let store = makeStore(server)

        await store.load(portfolioId: AnalyticsFixture.scopeID)

        // Re-resolved server-side against the user's own portfolios, which is
        // why the phone may send it without validating it first.
        #expect(server.lastQuery?.contains("p=\(AnalyticsFixture.scopeID)") == true)
    }

    @Test("All sends no query, so a stale chip cannot impersonate a portfolio")
    func allSendsNoQuery() async {
        let server = FakeAnalyticsServer()
        server.response = AnalyticsFixture.response(scopeId: nil)
        let store = makeStore(server)

        await store.load()

        #expect(server.lastQuery == nil || server.lastQuery?.isEmpty == true)
        #expect(store.selectedScopeID == AnalyticsStore.allScopeID)
    }

    @Test("a failed first load says so; a failed refresh keeps the figures")
    func keepsViewOnRefreshFailure() async {
        let server = FakeAnalyticsServer()
        let store = makeStore(server)
        await store.load()
        #expect(store.view != nil)

        server.failure = 500
        await store.reload()

        #expect(store.view?.xirr.value == "+12,34%")
        #expect(store.errorMessage == nil)
    }

    @Test("the first load failing does say so")
    func reportsFirstFailure() async {
        let server = FakeAnalyticsServer()
        server.failure = 500
        let store = makeStore(server)

        await store.load()

        #expect(store.errorMessage == AnalyticsStore.genericError)
        #expect(store.hasLoaded)
        #expect(store.view == nil)
    }

    @Test("a cached payload paints before the network answers, per scope")
    func cachedPerScope() async {
        let caches = FakePayloadCacheFamily<AnalyticsResponse>()
        let server = FakeAnalyticsServer()
        let store = makeStore(server, caches: caches)

        await store.load(portfolioId: AnalyticsFixture.scopeID)

        // One file per scope. All sharing a portfolio's file would paint
        // one portfolio's returns as the whole book.
        #expect(caches.keys == [AnalyticsFixture.scopeID])
    }

    @Test("no token means no request at all")
    func withoutToken() async {
        let server = FakeAnalyticsServer()
        let store = makeStore(server, token: nil)

        await store.load()

        #expect(server.calls == 0)
    }

    @Test("sign-out leaves nothing behind")
    func purges() async {
        let server = FakeAnalyticsServer()
        let store = makeStore(server)
        await store.load()

        store.purge()

        #expect(store.view == nil)
        #expect(!store.hasLoaded)
        #expect(store.selectedScopeID == AnalyticsStore.allScopeID)
    }
}

@Suite("Allocation dimension")
struct AllocationDimensionTests {
    @Test("the four tabs are the web's four tabs, in order, with the web's labels")
    func mirrorsWeb() {
        #expect(AllocationDimension.allCases == [.ticker, .portfolio, .currency, .sector])
        #expect(AllocationDimension.allCases.map(\.label) == [
            "Company", "Portfolio", "Currency", "Industry",
        ])
    }

    @Test("switching a dimension reads a fold that already arrived")
    func readsExistingFold() {
        let breakdown = AnalyticsFixture.response().breakdown
        #expect(AllocationDimension.ticker.slices(in: breakdown).map(\.key) == ["AAPL"])
        #expect(AllocationDimension.currency.slices(in: breakdown).map(\.key) == ["USD"])
    }
}

@Suite("Allocation token")
struct AllocationTokenTests {
    @Test("a CSS variable names a generated token, never a colour literal")
    func mapsCategoryVars() {
        #expect(AllocationToken.token(for: "var(--color-cat-1)") == Tokens.cat1)
        #expect(AllocationToken.token(for: "var(--color-cat-8)") == Tokens.cat8)
        #expect(AllocationToken.token(for: "var(--color-cat-unknown)") == Tokens.catUnknown)
        // An unrecognised variable must not borrow a category colour — that
        // would paint an unclassified slice as a classified one.
        #expect(AllocationToken.token(for: "var(--color-gain)") == Tokens.catUnknown)
    }
}
