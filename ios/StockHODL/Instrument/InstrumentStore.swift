import Foundation
import Observation

/// Everything the instrument screen reads.
///
/// Two independent reads with two independent failure modes, which is why they
/// are two pieces of state rather than one: the detail can be missing (404 —
/// not this user's instrument) while the series is merely empty, and a range
/// that fails must not blank out the header that is already correct.
///
/// Both halves are cached on disk, PER SYMBOL and — for the series — per
/// range, because that is the granularity at which they are asked for. This
/// was the worst offline screen in the app: every tap from a holdings list
/// into a stock produced a spinner and then a full-screen error, while the
/// figures for that exact stock sat in the App Group snapshot the list had
/// just been drawn from.
@MainActor
@Observable
final class InstrumentStore {
    let symbol: String

    private(set) var detail: InstrumentResponse?
    private(set) var series: SeriesPayload?
    private(set) var seriesState: ChartState = .loading

    /// Which range is charted. Remembered app-wide, so the chart opens on
    /// whatever the user last chose rather than resetting on every tap.
    var range: ChartRange {
        didSet {
            guard oldValue != range else { return }
            range.remember(in: defaults)
            reloadSeries()
        }
    }

    /// Line or candles. Remembered app-wide, like the range: a user who reads
    /// candles reads candles on every stock.
    var style: ChartStyle {
        didSet {
            guard oldValue != style else { return }
            style.remember(in: defaults)
        }
    }

    private(set) var isLoading = true
    private(set) var errorMessage: String?
    /// The server's own "not yours / no such thing". Distinct from an error:
    /// there is nothing to retry, and offering a Try again button would be a
    /// lie about what happened.
    private(set) var isMissing = false

    /// Freshness, shared with every other store — see `StaleState`.
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    /// The header's worth of facts the app already had before this screen was
    /// opened — see `InstrumentSeed`. Read only while `detail` is nil, and
    /// never merged into it: the seed knows the name and the price and
    /// explicitly does not know the position.
    var seed: InstrumentSeed?

    static let genericError = "Could not load this instrument."

    private let client: InstrumentClient
    private let cache: any PayloadCaching<InstrumentResponse>
    /// A cache per range: `1D` and `1Y` are different questions with different
    /// shelf lives, and one file would let a tap through the range tabs
    /// overwrite the answer to whichever was asked last.
    private let makeSeriesCache: @Sendable (String) -> any PayloadCaching<SeriesPayload>
    /// Watching is membership, and membership has its own endpoints. Optional
    /// so this store still builds from an `InstrumentClient` alone — every
    /// screen must stay constructible from fakes, and a watch button is not
    /// worth making that impossible.
    private let watchlist: WatchlistClient?
    /// Deleting a transaction from this screen goes through the same journal
    /// endpoint `TransactionsStore` uses. Optional for the same reason
    /// `watchlist` is: fakes and previews stay constructible without it, and
    /// then the row simply offers no delete affordance.
    private let transactionsClient: TransactionsClient?
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio — see `LiveStore` for why it is injected.
    private let isConnected: @MainActor () -> Bool
    /// Injected for the same reason `LiveStore`'s is — see the note there.
    private let defaults: UserDefaults
    /// The one in-flight series task. A user tapping through 1D→5D→1M faster
    /// than the network answers must not get whichever response happens to land
    /// last painted under whichever tab happens to be selected.
    private var seriesTask: Task<Void, Never>?

    init(
        symbol: String,
        client: InstrumentClient,
        seed: InstrumentSeed? = nil,
        cache: (any PayloadCaching<InstrumentResponse>)? = nil,
        makeSeriesCache: (@Sendable (String) -> any PayloadCaching<SeriesPayload>)? = nil,
        watchlist: WatchlistClient? = nil,
        transactionsClient: TransactionsClient? = nil,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        range: ChartRange? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.symbol = symbol
        self.client = client
        self.seed = seed
        self.cache = cache ?? DiskCache<InstrumentResponse>(
            key: "instrument-\(symbol)",
            ttl: CacheTTL.quotes
        )
        self.makeSeriesCache = makeSeriesCache ?? { key in
            // Intraday goes stale in an hour; a daily-or-longer walk now
            // carries today's still-forming last, so it uses the same hour
            // bound rather than a day of yesterday-without-today.
            let intraday = key.hasSuffix("1D") || key.hasSuffix("5D")
            return DiskCache<SeriesPayload>(
                key: "series-\(key)",
                ttl: intraday ? CacheTTL.intradaySeries : CacheTTL.formingDailySeries
            )
        }
        self.isConnected = isConnected
        self.watchlist = watchlist
        self.transactionsClient = transactionsClient
        self.tokenProvider = tokenProvider
        self.defaults = defaults
        self.range = range ?? .remembered(in: defaults)
        style = ChartStyle.remembered(in: defaults)
    }

    // MARK: - Watching

    /// The watch flag, with the last local change winning until the next load.
    ///
    /// Optimistic on purpose: the server's answer is already known — a
    /// successful POST means watched, a successful DELETE means not — so
    /// waiting for a reload before moving the control would make a one-bit
    /// toggle feel like a form submission.
    private(set) var watchOverride: Bool?

    var isWatched: Bool { watchOverride ?? detail?.watched ?? false }

    /// True while the watch write is in flight, so the control can disable
    /// rather than let a double tap queue an add behind a remove.
    private(set) var isTogglingWatch = false

    /// Add or remove, whichever the current state calls for.
    ///
    /// Adding submits the whole instrument (symbol, name, exchange, currency)
    /// rather than a bare ticker, exactly as the watchlist screen does: the
    /// row may have to MINT the `instruments` entry, and `instruments` is
    /// global and first-write-wins, so a guessed currency would bind the
    /// symbol permanently. Every field here came from the server's own row for
    /// this instrument, which is the one source that cannot be guessing.
    func toggleWatch() async {
        guard let watchlist, let token = tokenProvider(), let detail else { return }
        isTogglingWatch = true
        defer { isTogglingWatch = false }

        do {
            if isWatched {
                try await watchlist.remove(instrumentId: detail.instrumentId, token: token)
                watchOverride = false
            } else {
                try await watchlist.add(
                    WatchlistAddRequest(
                        symbol: detail.symbol,
                        displayName: detail.displayName,
                        exchange: detail.exchange,
                        currency: detail.currency
                    ),
                    token: token
                )
                watchOverride = true
            }
            errorMessage = nil
        } catch let APIError.http(status, _) where status == 404 && isWatched {
            // Already gone — removed from the web, or a second tap. Reflect
            // it rather than leave a control that cannot be operated.
            watchOverride = false
        } catch {
            #if DEBUG
                print("[instrument] watch toggle failed: \(error)")
            #endif
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not change your watchlist."
            ) ?? "Could not change your watchlist."
        }
    }

    func dismissError() { errorMessage = nil }

    // MARK: - Price targets

    /// The list, with the last mutation's answer winning until the next load —
    /// the `watchOverride` pattern. Both mutation routes return the
    /// instrument's fresh list, so a write never needs a full detail refetch.
    private(set) var targetsOverride: [PriceTarget]?

    var priceTargets: [PriceTarget] { targetsOverride ?? detail?.priceTargets ?? [] }

    /// The status sentence's twin of `targetsOverride`, adopted from the same
    /// mutation responses and cleared in the same two places. FLAGGED rather
    /// than `??`-chained, deliberately: deleting the last line answers a
    /// legitimate `nil` status, and that nil must WIN over the stale detail
    /// payload — a `statusOverride ?? detail?.targetStatus` would resurrect
    /// the deleted line's sentence until the next full load.
    private(set) var statusOverride: TargetStatus?
    private var hasStatusOverride = false

    var targetStatus: TargetStatus? {
        hasStatusOverride ? statusOverride : detail?.targetStatus
    }

    /// True while a create is in flight, so the sheet's Save can disable
    /// rather than let a double tap draw the same line twice.
    private(set) var isSavingTarget = false

    /// Rows whose delete is in flight — per row, so removing one target does
    /// not freeze the others' buttons.
    private(set) var deletingTargetIds: Set<String> = []

    /// Rows this screen has already removed since the last load. Two deletes
    /// can be in flight at once and the earlier request's answer can land
    /// last, still listing the other row — so any adopted list drops these,
    /// and a finished delete never resurrects a row. The next load restates
    /// everything and clears it.
    private var removedTargetIds: Set<String> = []

    static let genericTargetError = "Could not set that target."

    /// POST the line; returns the sentence to show under the field, or nil on
    /// success. The server's own refusals (held-or-watched, USD-only, "that is
    /// the current price", no price available) arrive via `ErrorBody` and are
    /// shown verbatim — each one tells the user what to change.
    func createTarget(price: String) async -> String? {
        guard let token = tokenProvider(), let detail else {
            return InstrumentStore.genericTargetError
        }
        isSavingTarget = true
        defer { isSavingTarget = false }

        do {
            let response = try await client.createTarget(
                PriceTargetCreateRequest(instrumentId: detail.instrumentId, targetPrice: price),
                token: token
            )
            let gone = deletingTargetIds.union(removedTargetIds)
            targetsOverride = response.targets.filter { !gone.contains($0.id) }
            statusOverride = response.status
            hasStatusOverride = true
            return nil
        } catch let APIError.http(_, message) {
            return message ?? InstrumentStore.genericTargetError
        } catch {
            #if DEBUG
                print("[instrument] create target failed: \(error)")
            #endif
            return LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: InstrumentStore.genericTargetError
            ) ?? InstrumentStore.genericTargetError
        }
    }

    /// Delete one line. The server answers the fresh list when the row
    /// existed; an idempotent no-op answers empty (it cannot know the
    /// instrument), and then the honest local state is this list minus the
    /// row — either way the row is gone. Two deletes can be in flight at
    /// once, and the earlier request's list may arrive last still carrying
    /// the other row — so every row still being deleted is dropped from
    /// whatever list is adopted, and a finished delete never resurrects one.
    func deleteTarget(_ target: PriceTarget) async {
        guard let token = tokenProvider() else { return }
        deletingTargetIds.insert(target.id)
        defer { deletingTargetIds.remove(target.id) }

        do {
            let response = try await client.deleteTarget(id: target.id, token: token)
            removedTargetIds.insert(target.id)
            let adopted = response.targets.isEmpty ? priceTargets : response.targets
            let gone = deletingTargetIds.union(removedTargetIds)
            targetsOverride = adopted.filter { !gone.contains($0.id) }
            // Adopt the recomputed status when the server actually knew the
            // instrument (a non-empty list), or when nothing remains locally
            // either — then its null IS the truth and the sentence must go.
            // The idempotent no-op (empty answer, rows still here) cannot
            // know the status and must not blank a sentence about them.
            if !response.targets.isEmpty || targetsOverride?.isEmpty == true {
                statusOverride = response.status
                hasStatusOverride = true
            }
        } catch {
            #if DEBUG
                print("[instrument] delete target failed: \(error)")
            #endif
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not remove that target."
            ) ?? "Could not remove that target."
        }
    }

    /// Delete one of this instrument's own transactions, then reload —
    /// position, groups and the transaction list are all server-derived, so a
    /// local splice would have to recompute the average cost itself. A full
    /// reload is the one implementation that cannot drift from the journal's.
    func deleteTransaction(_ row: TransactionRow) async {
        guard let transactionsClient, let token = tokenProvider() else { return }

        do {
            try await transactionsClient.delete(id: row.id, token: token)
        } catch let APIError.http(status, _) where status == 404 {
            // Already gone — deleted from the web, or a second tap. Reload
            // below shows the current, correct state either way.
        } catch {
            #if DEBUG
                print("[instrument] delete transaction failed: \(error)")
            #endif
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not delete that transaction."
            ) ?? "Could not delete that transaction."
            return
        }

        await load()
    }

    // MARK: - Loading

    /// Both halves, concurrently. Same reasoning as Holdings: neither needs the
    /// other's answer, and a phone pays the round trip twice if they queue.
    func load() async {
        stale.connectivityChanged(to: isConnected())

        // Disk first, both halves. This is the difference between tapping a
        // ticker on a train and getting the stock's page, and tapping it and
        // getting an apology.
        if detail == nil, let cached = cache.read() {
            detail = cached.value
            stale.restored(from: cached.capturedAt)
            isMissing = false
            isLoading = false
        }
        if series == nil, let cachedSeries = seriesCache(for: range).read() {
            apply(series: cachedSeries.value)
        }

        // No token is a real failure, not a reason to hang: `isLoading`
        // starts true, so returning here left the screen on its spinner with
        // nothing on the way and no way back except popping.
        guard let token = tokenProvider() else {
            isLoading = false
            recordFailure()
            return
        }

        // A range switch still in flight would land after this one and paint
        // the wrong window under the selected tab.
        seriesTask?.cancel()

        async let detailCall = client.detail(symbol: symbol, token: token)
        async let seriesCall = client.priceSeries(symbol: symbol, range: range, token: token)

        // The series is allowed to fail on its own — an empty chart above a
        // correct position is a far better screen than an error over both.
        let freshSeries = try? await seriesCall
        apply(series: freshSeries)
        if let freshSeries { seriesCache(for: range).write(freshSeries) }

        do {
            let fresh = try await detailCall
            detail = fresh
            let now = Date()
            stale.succeeded(at: now)
            cache.write(fresh, at: now)
            // The server has just restated the flag; the optimistic value has
            // done its job and must not outlive it, or a watch removed from
            // the web would keep showing as watched here.
            watchOverride = nil
            // Same rule for the target list: the payload just restated it.
            targetsOverride = nil
            statusOverride = nil
            hasStatusOverride = false
            removedTargetIds = []
            isMissing = false
            errorMessage = nil
        } catch let APIError.http(status, _) where status == 404 {
            isMissing = true
            errorMessage = nil
            // The server has said this instrument is not this user's. A cached
            // copy of it is now a lie with an expiry date, so it goes — this
            // is the one answer that proves anything.
            detail = nil
            seed = nil
            targetsOverride = nil
            statusOverride = nil
            hasStatusOverride = false
            removedTargetIds = []
            cache.clear()
            stale.reset()
        } catch {
            #if DEBUG
                print("[instrument] \(symbol) failed: \(error)")
            #endif
            recordFailure(error)
        }

        isLoading = false
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        // Only shout when there is nothing on screen. A refresh that fails
        // over a painted header is a staleness problem, not an outage.
        if detail == nil {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: InstrumentStore.genericError
            )
        }
    }

    /// The cache for one range. Keyed by symbol AND range because both are
    /// part of the question the payload answers.
    private func seriesCache(for range: ChartRange) -> any PayloadCaching<SeriesPayload> {
        makeSeriesCache("\(symbol)-\(range.rawValue)")
    }

    private func reloadSeries() {
        seriesTask?.cancel()
        let wanted = range
        // Paint the cached window for the newly selected range immediately
        // rather than dropping to a spinner. Tapping through 1D→5D→1M offline
        // used to give three spinners that each resolved to an error.
        if let cached = seriesCache(for: wanted).read() {
            apply(series: cached.value)
        } else {
            seriesState = .loading
        }
        seriesTask = Task { [weak self] in
            guard let self, let token = tokenProvider() else { return }
            let fresh = try? await client.priceSeries(symbol: symbol, range: wanted, token: token)
            guard !Task.isCancelled else { return }
            // The range may have moved on while this was in flight; writing
            // then would file one range's points under another's key.
            guard wanted == range else { return }
            apply(series: fresh)
            if let fresh { seriesCache(for: wanted).write(fresh) }
        }
    }

    /// An empty payload and a failed request are different things and get
    /// different states: "no data for this range" is an answer, "couldn't load"
    /// is a question the user can retry.
    private func apply(series fresh: SeriesPayload?) {
        guard let fresh else {
            // A failure over a chart that is already drawn leaves it drawn.
            // The bar above the screen says how old everything is; replacing
            // a real line with an error box says less and costs more.
            if series == nil { seriesState = .error }
            return
        }
        series = fresh
        seriesState = fresh.points.count >= 2 ? .ready : .empty
    }

    // MARK: - Derived

    /// The position figures, when the instrument is actually owned. A watched
    /// but unowned instrument has none, and rendering zeros for it would claim
    /// a position that does not exist.
    var position: PositionFigures? { detail?.position }

    var groups: [PortfolioGroup] { detail?.groups ?? [] }

    var transactions: [TransactionRow] { detail?.transactions ?? [] }

    /// The chart plots the instrument's own currency, not PLN: this is a price
    /// series, and converting it would draw the złoty's movements into a line
    /// the user reads as the stock's.
    var currency: String { detail?.currency.rawValue ?? "USD" }

    var points: [ChartPoint] { series?.points ?? [] }
}
