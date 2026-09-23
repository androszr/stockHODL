import Foundation
import Testing

@testable import StockHODL

/// A server for the transaction screens.
private final class FakeTxServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var writes: [(method: String, path: String, body: Data?)] = []
    private(set) var searches: [String] = []
    private(set) var fxCalls: [String] = []

    var rows: [TransactionRow] = [LiveFixture.transaction()]
    var portfolios: [Portfolio] = [Portfolio(id: "p1", name: "Main", sortOrder: 0, txCount: 1)]
    var searchResults: [SymbolMatch] = [LiveFixture.match()]
    var searchDegraded = false
    var searchFails = false
    var fx: FxRateResponse = FxRateResponse(ok: true, rate: "4.0512", rateDate: "2026-03-03", reason: nil)
    var listFails = false
    /// Status for any write. 400 and 409 carry the server's own message.
    var writeStatus = 200
    var writeMessage = "quantity: Must be greater than zero"

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
                    ? Data(#"{"ok":true,"id":"new-id"}"#.utf8)
                    : Data(#"{"message":"\#(lock.withLock { writeMessage })"}"#.utf8)
                return (body, Self.response(url, status))
            }

            if path.hasSuffix("/symbols/search") {
                let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "q" }?.value ?? ""
                let fails = lock.withLock { () -> Bool in
                    searches.append(q)
                    return searchFails
                }
                if fails { throw URLError(.timedOut) }
                let payload = lock.withLock {
                    SymbolSearchResponse(degraded: searchDegraded ? true : nil, results: searchResults)
                }
                return (try JSONEncoder().encode(payload), Self.response(url, 200))
            }

            if path.hasSuffix("/fx-rate") {
                let date = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "tradeDate" }?.value ?? ""
                let payload = lock.withLock { () -> FxRateResponse in
                    fxCalls.append(date)
                    return fx
                }
                return (try JSONEncoder().encode(payload), Self.response(url, 200))
            }

            if path.hasSuffix("/portfolios") {
                let payload = lock.withLock { PortfolioList(portfolios: portfolios) }
                return (try JSONEncoder().encode(payload), Self.response(url, 200))
            }

            let (fails, payload) = lock.withLock { (listFails, TransactionList(transactions: rows)) }
            if fails { throw URLError(.notConnectedToInternet) }
            return (try JSONEncoder().encode(payload), Self.response(url, 200))
        }
    }

    private static func response(_ url: URL, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

@MainActor
private func makeList(
    _ server: FakeTxServer,
    token: String? = "t",
    cache: FakePayloadCache<[TransactionRow]> = FakePayloadCache<[TransactionRow]>(),
    connected: Bool = true
) -> TransactionsStore {
    TransactionsStore(
        // In memory, never the real Caches directory — see `FakeCaches`.
        client: client(server),
        cache: cache,
        tokenProvider: { token },
        isConnected: { connected }
    )
}

@MainActor
private func makeForm(
    _ server: FakeTxServer,
    editing: TransactionRow? = nil,
    token: String? = "t"
) -> TransactionFormStore {
    // A debounce short enough to observe without sleeping through it. The
    // BEHAVIOUR under test is "three keystrokes, one call", not the duration.
    let debounce = Duration.milliseconds(1)
    guard let editing else {
        return TransactionFormStore(
            client: client(server),
            tokenProvider: { token },
            searchDebounce: debounce
        )
    }
    return TransactionFormStore.editing(
        editing,
        client: client(server),
        tokenProvider: { token },
        searchDebounce: debounce
    )
}

private func client(_ server: FakeTxServer) -> TransactionsClient {
    TransactionsClient(
        api: APIClient(
            config: AppConfig(baseURL: URL(string: "https://example.test")!),
            transport: server.transport()
        )
    )
}

// MARK: - List

@Suite("Transactions list")
@MainActor
struct TransactionsStoreTests {
    @Test("groups rows by trade date, preserving the server's order")
    func grouping() async {
        let server = FakeTxServer()
        server.rows = [
            LiveFixture.transaction(id: "a"),
            LiveFixture.transaction(id: "b"),
            LiveFixture.transaction(id: "c", tradeDate: "2026-03-01"),
        ]
        let store = makeList(server)
        await store.load()

        #expect(store.sections.map(\.date) == ["2026-03-04", "2026-03-01"])
        #expect(store.sections[0].rows.count == 2)
    }

    @Test("a delete removes the row locally without a reload")
    func deleteRemoves() async {
        let server = FakeTxServer()
        let store = makeList(server)
        await store.load()

        await store.delete(server.rows[0])

        #expect(store.rows.isEmpty)
        #expect(server.writes.map(\.method) == ["DELETE"])
    }

    @Test("deleting something already gone drops it and says so")
    func deleteStale() async {
        let server = FakeTxServer()
        let store = makeList(server)
        await store.load()
        server.writeStatus = 404

        await store.delete(server.rows[0])

        // Unlike the web action, the phone acts on the verdict: a client
        // working from its own snapshot should learn its list is stale rather
        // than believe it just deleted something.
        #expect(store.rows.isEmpty)
        #expect(store.staleNotice != nil)
    }

    @Test("a failed load with rows already on screen is not an error")
    func staleListIsNotAnError() async {
        let server = FakeTxServer()
        let store = makeList(server)
        await store.load()
        server.listFails = true

        await store.load()

        #expect(store.errorMessage == nil)
        #expect(!store.rows.isEmpty)
    }

    @Test("a failed load with nothing on screen is")
    func emptyFailureIsAnError() async {
        let server = FakeTxServer()
        server.listFails = true
        let store = makeList(server)

        await store.load()

        // The fake fails with `.notConnectedToInternet`, so the screen names
        // the network rather than blaming itself.
        #expect(store.errorMessage == LoadFailure.offline)
    }

    @Test("a cached journal paints before the network answers, and admits it is unconfirmed")
    func cachedJournalPaints() async {
        let server = FakeTxServer()
        server.listFails = true
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        let cache = FakePayloadCache(seed: [LiveFixture.transaction()], capturedAt: taken)
        let store = makeList(server, cache: cache)

        await store.load()

        #expect(!store.rows.isEmpty)
        #expect(store.errorMessage == nil, "there are rows on screen; nothing to apologise for")
        #expect(store.freshness == .stale(since: taken))
    }

    @Test("a delete rewrites the cache, so the row does not come back on the next launch")
    func deleteRewritesCache() async {
        let server = FakeTxServer()
        let cache = FakePayloadCache<[TransactionRow]>()
        let store = makeList(server, cache: cache)
        await store.load()
        let row = try! #require(store.rows.first)

        await store.delete(row)

        let cached = try! #require(cache.read())
        #expect(!cached.value.contains { $0.id == row.id })
    }

    /// The Holdings chart's trade markers open the journal on every
    /// reselection of the tab. A cached journal inside the ledger TTL answers
    /// that without a request; a write to the cache is the fingerprint of the
    /// fetch this must not have made.
    @Test("a journal inside the ledger TTL paints without a request")
    func loadIfNeededSkipsAFreshJournal() async {
        let server = FakeTxServer()
        let taken = Date().addingTimeInterval(-60)
        let cache = FakePayloadCache(seed: [LiveFixture.transaction(id: "cached")], capturedAt: taken)
        let store = makeList(server, cache: cache)

        await store.loadIfNeeded()

        #expect(store.rows.map(\.id) == ["cached"])
        #expect(!store.isLoading)
        #expect(cache.writes == 0)
    }

    @Test("a journal older than the ledger TTL is refetched")
    func loadIfNeededRefetchesAnOldJournal() async {
        let server = FakeTxServer()
        server.rows = [LiveFixture.transaction(id: "fresh")]
        let taken = Date().addingTimeInterval(-(CacheTTL.ledger + 60))
        let cache = FakePayloadCache(seed: [LiveFixture.transaction(id: "cached")], capturedAt: taken)
        let store = makeList(server, cache: cache)

        await store.loadIfNeeded()

        #expect(store.rows.map(\.id) == ["fresh"])
        #expect(cache.writes == 1)
    }

    /// The TTL gate is a fortnight wide, and no write anywhere else in the app
    /// touches these rows — so an add path that did not invalidate would leave
    /// the trade the user just recorded unmarked on the chart whose line had
    /// already moved for it. `invalidate()` is what the add paths call.
    @Test("an invalidated journal is refetched even though it is inside the TTL")
    func invalidateForcesTheNextLoadIfNeeded() async {
        let server = FakeTxServer()
        server.rows = [LiveFixture.transaction(id: "fresh")]
        let cache = FakePayloadCache(
            seed: [LiveFixture.transaction(id: "cached")],
            capturedAt: Date().addingTimeInterval(-60)
        )
        let store = makeList(server, cache: cache)

        await store.loadIfNeeded()
        #expect(store.rows.map(\.id) == ["cached"])

        store.invalidate()
        await store.loadIfNeeded()

        #expect(store.rows.map(\.id) == ["fresh"])
        #expect(cache.writes == 1)
    }

    /// A clock that moved backwards makes an age negative. Treated as expired,
    /// the same reading `DiskCache` takes — "fresh forever" is the failure
    /// mode that keeps a wrong list on screen indefinitely.
    @Test("a journal captured in the future is refetched, not trusted")
    func loadIfNeededRefetchesAFuturePayload() async {
        let server = FakeTxServer()
        server.rows = [LiveFixture.transaction(id: "fresh")]
        let cache = FakePayloadCache(
            seed: [LiveFixture.transaction(id: "cached")],
            capturedAt: Date().addingTimeInterval(3600)
        )
        let store = makeList(server, cache: cache)

        await store.loadIfNeeded()

        #expect(store.rows.map(\.id) == ["fresh"])
    }
}

// MARK: - Form

@Suite("Transaction form")
@MainActor
struct TransactionFormStoreTests {
    @Test("a single portfolio is chosen without asking")
    func singlePortfolioAutoselected() async {
        let server = FakeTxServer()
        let store = makeForm(server)

        await store.load()

        #expect(store.draft.portfolioId == "p1")
        #expect(!store.draft.tradeDate.isEmpty)
    }

    @Test("two portfolios are not")
    func twoPortfoliosAsk() async {
        let server = FakeTxServer()
        server.portfolios.append(Portfolio(id: "p2", name: "IKE", sortOrder: 1, txCount: 0))
        let store = makeForm(server)

        await store.load()

        #expect(store.draft.portfolioId.isEmpty)
    }

    @Test("picking a match fills symbol, name and exchange as one choice")
    func chooseFillsThree() {
        let server = FakeTxServer()
        let store = makeForm(server)

        store.choose(LiveFixture.match(symbol: "MSFT", name: "Microsoft", exchange: "NASDAQ"))

        #expect(store.draft.symbol == "MSFT")
        #expect(store.draft.displayName == "Microsoft")
        #expect(store.draft.exchange == "NASDAQ")
        #expect(store.matches.isEmpty)
    }

    @Test("an unmapped exchange leaves the currency alone rather than guessing USD")
    func unmappedCurrencyUntouched() {
        let server = FakeTxServer()
        let store = makeForm(server)
        store.draft.currency = .gbp

        store.choose(LiveFixture.match(currency: nil))

        // Guessing would mint the instrument in the wrong currency —
        // permanently, since `instruments` is global and first-write-wins.
        #expect(store.draft.currency == .gbp)
    }

    @Test("search is debounced, and a failure reads as degraded")
    func searchDebounceAndFailure() async {
        let server = FakeTxServer()
        let store = makeForm(server)

        store.search("A")
        store.search("AA")
        store.search("AAP")
        await store.awaitSearch()

        // Three keystrokes, one paid provider call.
        #expect(server.searches == ["AAP"])
        #expect(store.matches.count == 1)
        #expect(!store.searchDegraded)

        server.searchFails = true
        store.search("XYZ")
        await store.awaitSearch()

        // "Search is broken, type it in yourself" — which is exactly what a
        // timeout means and an empty result does not.
        #expect(store.searchDegraded)
    }

    @Test("an empty query asks for nothing")
    func emptyQueryIsQuiet() async {
        let server = FakeTxServer()
        let store = makeForm(server)

        store.search("   ")
        await store.awaitSearch()

        #expect(server.searches.isEmpty)
        #expect(store.matches.isEmpty)
    }

    @Test("the FX rate autofills for a non-PLN currency")
    func fxAutofill() async {
        let server = FakeTxServer()
        let store = makeForm(server)
        store.draft.tradeDate = "2026-03-04"
        store.draft.currency = .usd

        await store.fetchFxRate()

        #expect(store.draft.fxRateToBase == "4.0512")
        #expect(store.fxNote == "NBP mid rate from 2026-03-03.")
    }

    @Test("PLN never asks NBP for a PLN/PLN rate")
    func plnSkipsFx() async {
        let server = FakeTxServer()
        let store = makeForm(server)
        store.draft.currency = .pln
        store.draft.tradeDate = "2026-03-04"

        await store.fetchFxRate()

        #expect(server.fxCalls.isEmpty)
    }

    @Test("each refusal reason gets its own sentence")
    func fxReasons() async {
        let server = FakeTxServer()
        let store = makeForm(server)
        store.draft.tradeDate = "2026-03-04"

        server.fx = FxRateResponse(ok: false, rate: nil, rateDate: nil, reason: .notPublished)
        await store.fetchFxRate()
        #expect(store.fxNote?.contains("No rate published") == true)

        // Collapsing these into "failed" would hide the one the user can act
        // on — waiting a day is not the same answer as typing the rate in.
        server.fx = FxRateResponse(ok: false, rate: nil, rateDate: nil, reason: .unavailable)
        await store.fetchFxRate()
        #expect(store.fxNote?.contains("unavailable") == true)
    }

    @Test("a bad date is not sent to the rate table")
    func fxNeedsAValidDate() async {
        let server = FakeTxServer()
        let store = makeForm(server)
        store.draft.tradeDate = "2026-02-30"

        await store.fetchFxRate()

        #expect(server.fxCalls.isEmpty)
    }

    @Test("saving an invalid draft touches every field instead of sending")
    func invalidSaveShowsEverything() async {
        let server = FakeTxServer()
        let store = makeForm(server)

        await store.save()

        #expect(server.writes.isEmpty)
        // A Save that appears to do nothing is worse than a form covered in
        // reasons, so every field is marked touched at that moment.
        #expect(store.issue(for: .symbol) == "Symbol is required")
        #expect(!store.didSave)
    }

    @Test("a valid draft POSTs and reports success")
    func createPosts() async {
        let server = FakeTxServer()
        let store = makeForm(server)
        await store.load()
        seed(store)

        await store.save()

        #expect(server.writes.map(\.method) == ["POST"])
        #expect(store.didSave)
        #expect(store.errorMessage == nil)
    }

    @Test("an edit PATCHes the id it was opened with")
    func editPatches() async {
        let server = FakeTxServer()
        let row = LiveFixture.transaction(id: "abc")
        let store = makeForm(server, editing: row)

        // Seeded from the stored row — raw decimal strings, so the form does
        // not have to parse a grouped figure back into money.
        #expect(store.draft.price == "182.40")
        #expect(store.draft.exchange == "NASDAQ")

        await store.save()

        #expect(server.writes.map(\.method) == ["PATCH"])
        #expect(server.writes[0].path.hasSuffix("/transactions/abc"))
    }

    @Test("the server's own refusal is what the user reads")
    func serverMessageWins() async {
        let server = FakeTxServer()
        server.writeStatus = 409
        server.writeMessage = "AAPL already exists as USD."
        let store = makeForm(server)
        await store.load()
        seed(store)

        await store.save()

        // A conflict this client could not have predicted deserves the
        // server's words, not a generic apology.
        #expect(store.errorMessage == "AAPL already exists as USD.")
        #expect(!store.didSave)
    }

    @Test("no token means no write at all")
    func withoutTokenDoesNothing() async {
        let server = FakeTxServer()
        let store = makeForm(server, token: nil)
        seed(store)

        await store.save()

        #expect(server.writes.isEmpty)
    }

    private func seed(_ store: TransactionFormStore) {
        store.draft.portfolioId = "p1"
        store.draft.symbol = "AAPL"
        store.draft.displayName = "Apple Inc."
        store.draft.exchange = "NASDAQ"
        store.draft.currency = .usd
        store.draft.quantity = "10"
        store.draft.price = "182,40"
        store.draft.tradeDate = "2026-03-04"
        store.draft.fxRateToBase = "4,05"
    }
}
