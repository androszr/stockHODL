import Foundation
import Testing

@testable import StockHODL

/// A dividends server. `@unchecked Sendable` over a lock, like every other
/// fake here.
private final class FakeDividendsServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var calls = 0
    private(set) var lastQuery: String?
    /// Every path + method the store asked for, so a test can assert that a
    /// write went where it should and that the reload after it did too.
    private(set) var trace: [String] = []

    var response = DividendsResponse(
        payments: [DividendFixture.payment()],
        summary: DividendFixture.summary(),
        years: [DividendFixture.year()]
    )
    var failure: Int?
    /// Status for POST/PATCH/DELETE — the reads keep their own `failure`.
    var writeStatus = 200

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path() ?? ""
            let method = request.httpMethod ?? "GET"
            let isWrite = method != "GET"

            let status = lock.withLock { () -> Int in
                trace.append("\(method) \(path)")
                if isWrite { return writeStatus }
                calls += 1
                lastQuery = request.url?.query
                return failure ?? 200
            }

            if isWrite {
                let http = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (Data(#"{"ok":true}"#.utf8), http)
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

private enum DividendFixture {
    static func payment(
        id: String = "11111111-1111-4111-8111-111111111111",
        currency: String = "USD",
        fxRateToBase: String? = "4.05",
        payDate: String? = "2026-02-13",
        grossAmount: String = "25.00",
        withheldTax: String = "3.75",
        netAmount: String = "21.25"
    ) -> DividendPayment {
        DividendPayment(
            amountPerShare: "0.25",
            currency: currency,
            displayName: "Apple Inc.",
            edited: false,
            exDate: "2026-02-06",
            fxRateToBase: fxRateToBase,
            grossAmount: grossAmount,
            id: id,
            instrumentId: "33333333-3333-4333-8333-333333333333",
            netAmount: netAmount,
            note: nil,
            payDate: payDate,
            portfolioId: "22222222-2222-4222-8222-222222222222",
            portfolioName: "Main",
            quantity: "100",
            source: .massive,
            symbol: "AAPL",
            withheldTax: withheldTax
        )
    }

    static func summary(
        netPLN: String? = "86.06",
        awaitingFx: Int = 0,
        fxUnsupported: Int = 0
    ) -> DividendSummary {
        DividendSummary(
            awaitingFx: awaitingFx,
            count: 1,
            fxUnsupported: fxUnsupported,
            netPLN: netPLN,
            ytdNetPLN: netPLN
        )
    }

    static func year(paymentIds: [String] = ["11111111-1111-4111-8111-111111111111"]) -> DividendYearGroup {
        DividendYearGroup(
            awaitingFx: 0,
            fxUnsupported: 0,
            netPLN: "86.06",
            paymentIds: paymentIds,
            totals: [DividendYearTotal(currency: "USD", gross: "25.00", net: "21.25", withheld: "3.75")],
            year: "2026"
        )
    }
}

@MainActor
private func makeStore(
    _ server: FakeDividendsServer,
    token: String? = "signed.token",
    caches: FakePayloadCacheFamily<DividendsResponse> = FakePayloadCacheFamily<DividendsResponse>(),
    connected: Bool = true
) -> DividendsStore {
    DividendsStore(
        client: DividendsClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        // In memory, never the real Caches directory. Without this a store
        // built here writes into the simulator's own cache and the NEXT test
        // paints from it — which is how this file first failed: a load that
        // was supposed to have nothing on screen had the previous test's
        // ledger sitting under it.
        makeCache: caches.make(),
        tokenProvider: { token },
        isConnected: { connected }
    )
}

@Suite("Dividends store")
@MainActor
struct DividendsStoreTests {
    @Test("the year groups join back to their rows")
    func joinsYearGroups() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)

        await store.load()

        #expect(store.years.count == 1)
        // The payload ships ids, not nested rows — a five-year history is the
        // ordinary case here and nesting would double the payload.
        #expect(store.payments(in: store.years[0]).map(\.symbol) == ["AAPL"])
    }

    @Test("an id with no matching row is dropped, not crashed on")
    func toleratesDanglingIds() async {
        let server = FakeDividendsServer()
        server.response = DividendsResponse(
            payments: [DividendFixture.payment()],
            summary: DividendFixture.summary(),
            years: [DividendFixture.year(paymentIds: ["11111111-1111-4111-8111-111111111111", "missing"])]
        )
        let store = makeStore(server)

        await store.load()

        #expect(store.payments(in: store.years[0]).count == 1)
    }

    @Test("filters travel as query parameters, not as client-side filtering")
    func sendsFilters() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)

        await store.load(portfolioId: "abc", symbol: "AAPL")

        // Both are re-resolved server-side against the user's own rows, which
        // is why the phone may send them without validating them first.
        #expect(server.lastQuery?.contains("p=abc") == true)
        #expect(server.lastQuery?.contains("symbol=AAPL") == true)
    }

    @Test("a failed first load says so; a failed refresh keeps the rows")
    func keepsRowsOnRefreshFailure() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load()
        #expect(store.payments.count == 1)

        server.failure = 500
        await store.load()

        // The list was true a moment ago. Blanking it to say "could not load"
        // loses more than it tells.
        #expect(store.payments.count == 1)
        #expect(store.errorMessage == nil)
    }

    @Test("the first load failing does say so")
    func reportsFirstFailure() async {
        let server = FakeDividendsServer()
        server.failure = 500
        let store = makeStore(server)

        await store.load()

        // A 500 is the SERVER having a bad minute, so the generic sentence
        // stands — telling the user their connection is at fault would send
        // them to restart a router that is working.
        #expect(store.errorMessage == DividendsStore.genericError)
        #expect(store.hasLoaded)
    }

    @Test("a cached ledger paints before the network answers, per filter")
    func cachedLedgerPaints() async {
        let caches = FakePayloadCacheFamily<DividendsResponse>()
        let server = FakeDividendsServer()
        let store = makeStore(server, caches: caches)

        await store.load(symbol: "AAPL")

        // One file per filter combination. A per-ticker view sharing the
        // unfiltered one's file would paint one stock's payments as the whole
        // ledger.
        #expect(caches.keys == ["all|AAPL"])
    }

    @Test("no token means no request at all")
    func withoutToken() async {
        let server = FakeDividendsServer()
        let store = makeStore(server, token: nil)

        await store.load()

        #expect(server.calls == 0)
    }

    @Test("sign-out leaves nothing behind")
    func purges() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load()

        store.purge()

        #expect(store.payments.isEmpty)
        #expect(store.years.isEmpty)
        #expect(store.summary == nil)
        #expect(!store.hasLoaded)
    }
}

@Suite("Dividend row")
struct DividendRowTests {
    @Test("a row with no pay date is dated by its ex-date and says so")
    func announcedOnly() {
        let announced = DividendFixture.payment(payDate: nil)

        #expect(announced.effectiveDate == "2026-02-06")
        // An announcement is not money received, and the row must not let one
        // read as the other.
        #expect(announced.isAnnouncedOnly)
    }

    @Test("the two unrated states are never the same state")
    func fxGapIsSplit() {
        // On the NBP allowlist: the next sync can still find this rate.
        #expect(DividendFixture.payment(currency: "USD", fxRateToBase: nil).fxGap == .awaiting)
        // Outside it: no PLN route will ever exist, and "awaiting" would be a
        // promise nothing can keep.
        #expect(DividendFixture.payment(currency: "ZAR", fxRateToBase: nil).fxGap == .unsupported)
        // Rated rows have no gap at all.
        #expect(DividendFixture.payment(fxRateToBase: "4.05").fxGap == nil)
    }
}

// MARK: - Writes

@Suite("Dividend writes")
@MainActor
struct DividendWriteTests {
    private func makeStore(_ server: FakeDividendsServer) -> DividendsStore {
        let config = AppConfig(baseURL: URL(string: "https://example.test")!)
        return DividendsStore(
            client: DividendsClient(api: APIClient(config: config, transport: server.transport())),
            makeCache: FakePayloadCacheFamily<DividendsResponse>().make(),
            tokenProvider: { "signed.token" }
        )
    }

    @Test("a vendor refresh posts, then reloads")
    func refreshThenReload() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load()

        await store.refreshFromVendor()

        #expect(server.trace.contains("POST /api/mobile/v1/dividends/refresh"))
        // The sync writes nothing the client can see; the reload is what puts
        // whatever landed on screen.
        #expect(server.trace.last?.hasPrefix("GET") == true)
        #expect(!store.isSyncing)
    }

    @Test("a refresh that could not reach the vendor says the ledger is unchanged")
    func refreshFailureIsHonest() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load()
        server.writeStatus = 500

        await store.refreshFromVendor()

        // Best-effort end to end: the payments are exactly as they were, and
        // the message says so rather than implying data was lost.
        #expect(store.errorMessage?.contains("unchanged") == true)
    }

    @Test("a write reloads the SAME view, never widening a per-ticker list")
    func reloadKeepsTheFilters() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load(symbol: "AAPL")

        await store.refreshFromVendor()

        // Silently falling back to the whole ledger after a write would show
        // the user rows they did not ask for, under a title that says AAPL.
        #expect(server.lastQuery?.contains("symbol=AAPL") == true)
    }

    @Test("deleting removes that payment, then reloads")
    func deletes() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load()
        let payment = store.payments[0]

        await store.delete(payment)

        #expect(server.trace.contains("DELETE /api/mobile/v1/dividends/\(payment.id)"))
        #expect(store.errorMessage == nil)
    }

    @Test("deleting a row that is already gone is not an error")
    func deleteOfAnAlreadyGoneRow() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load()
        let payment = store.payments[0]
        server.writeStatus = 404

        await store.delete(payment)

        // Deleted on the web, or a second tap. Complaining about a row that is
        // not there tells the user nothing they can act on.
        #expect(store.errorMessage == nil)
    }

    @Test("a failed delete says so and does not pretend the row is gone")
    func failedDelete() async {
        let server = FakeDividendsServer()
        let store = makeStore(server)
        await store.load()
        let payment = store.payments[0]
        server.writeStatus = 500

        await store.delete(payment)

        #expect(store.errorMessage != nil)
        #expect(store.payments.count == 1)
    }
}
