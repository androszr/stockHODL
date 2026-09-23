import Foundation
import Observation

/// The Options tab.
///
/// Parallel to `LiveStore` and `WatchlistStore`, and deliberately sharing NO
/// type with them beyond the display primitives. That is the financial
/// isolation made structural: `option_positions` never joins
/// `instruments`/`transactions` on the server, no option figure may enter a
/// PLN total, and the two summaries are never summed. A store that held both
/// would make adding them a one-line mistake away.
///
/// POLL ONLY, at 60 s. There is no options stream on the server — the vendor's
/// options socket entitlement is unverified, and 60 s is honest for figures
/// already delayed 15 minutes. The gate is the web's, verbatim
/// (`use-options-poll.ts`): run only while the app is FOREGROUND and some
/// session is trading or about to. A phone left in a pocket over a weekend
/// would otherwise issue ~1,440 pointless requests a day — the exact bug the
/// web file records having fixed.
///
/// The cache is a `DiskCache` under Caches rather than the App Group
/// container — options hold no PLN, no widget draws them, and the container is
/// for the one payload a widget reads (the watchlist's reasoning, verbatim).
/// The book and its chart are cached SEPARATELY: the chart is the optional
/// half of this screen on the wire, and a single file would mean a missing
/// chart could cost the cards too.
@MainActor
@Observable
final class OptionsStore {
    private(set) var payload: OptionsPayload?
    private(set) var series: SeriesPayload?
    /// The range `series` was fetched FOR. `range` moves the instant a tab is
    /// tapped; the points move when the fetch lands. Between the two, the
    /// chart must not label the old window's change with the new window's
    /// name — so the view reads `seriesState`, which is `.loading` until
    /// these agree.
    private(set) var seriesRange: OptionsChartRange?
    /// The range whose own fetch failed with nothing of its own on screen.
    /// Scoped to a range, not a flag: another tab has not failed, it is
    /// loading. Distinct from a failed REFRESH of the range already drawn,
    /// which keeps the old chart (see `loadSeries`).
    private(set) var failedRange: OptionsChartRange?

    /// What the chart draws, decided here so both the tab and its tests read
    /// one answer. A series for another range is not "ready" — it is the
    /// previous tab's numbers under this tab's label.
    var seriesState: ChartState {
        if failedRange == range { return .error }
        guard let series, seriesRange == range else { return .loading }
        return series.points.isEmpty ? .empty : .ready
    }

    private(set) var isLoading = true
    private(set) var errorMessage: String?

    /// The freshness bookkeeping, shared with `LiveStore` and
    /// `WatchlistStore` rather than written out a third time.
    private(set) var stale = StaleState()

    var isOffline: Bool { stale.isOffline }
    var freshness: Freshness { stale.freshness }

    /// Deliberately NOT persisted: a sticky invisible filter is the trap the
    /// portfolio scope refused, and the default must always be the honest
    /// small list. Same decision as the web's `showExpired`.
    var showExpired = false

    var sort = OptionsSort.remembered() {
        didSet { sort.remember() }
    }

    /// Value or Return on the options chart. Display-only: every point in the
    /// payload carries both `v` and `r`, so toggling costs no request — the
    /// same guarantee the web's `ModeToggle` makes. Remembered under the
    /// OPTIONS key, separately from the Holdings chart's.
    var chartMode = ChartMode.remembered(for: .options) {
        didSet {
            guard oldValue != chartMode else { return }
            chartMode.remember(for: .options)
        }
    }

    /// `UserDefaults` is injected rather than reached for — process-wide
    /// state, and a test that tapped a range would decide what an unrelated
    /// test's first request asked for.
    var range: OptionsChartRange {
        didSet {
            range.remember(in: defaults)
            // A failure belonged to the tab that was tapped then; this tab
            // starts loading, not errored.
            failedRange = nil
            // Paint the cached window for this range at once rather than
            // dropping to a skeleton — `InstrumentStore.reloadSeries`'s rule.
            // Per-range files, so this can never be another range's points.
            if let cached = seriesCache(for: range).read() {
                series = cached.value
                seriesRange = range
            }
            Task { await loadSeries() }
        }
    }

    static let genericError = "Could not load your options."

    private let client: OptionsClient
    private let cache: any PayloadCaching<OptionsPayload>
    /// One file PER RANGE, like the instrument chart's. A single file cannot
    /// say which range it holds, and `range` is remembered on the tap while
    /// the series is written when a fetch lands — so a failed or interrupted
    /// fetch left the two disagreeing, and a relaunch drew last month's
    /// change under "all time".
    private let makeSeriesCache: @Sendable (String) -> any PayloadCaching<SeriesPayload>
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio — see `LiveStore` for why it is injected.
    private let isConnected: @MainActor () -> Bool
    /// The cadence between ticks. Injected ONLY so a test can watch the gate
    /// close and reopen without waiting a real minute; production always gets
    /// `OptionsStore.pollInterval`.
    private let pollInterval: Duration
    /// The wall clock the market gate reads. Injected ONLY so a test can hold
    /// the gate shut and then open it deterministically; production always
    /// gets `Date.init`.
    private let now: @MainActor () -> Date
    private let defaults: UserDefaults
    private var pump: Task<Void, Never>?
    /// Whether this tab has ever been opened. The scene wiring lives in the
    /// shell now, above every tab, and a store nobody has opened must stay
    /// cold — otherwise coming back to the foreground would fetch three tabs
    /// the user never looked at.
    private(set) var hasStarted = false

    init(
        client: OptionsClient,
        cache: any PayloadCaching<OptionsPayload> = DiskCache<OptionsPayload>(
            key: "options",
            ttl: CacheTTL.quotes
        ),
        makeSeriesCache: (@Sendable (String) -> any PayloadCaching<SeriesPayload>)? = nil,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        pollInterval: Duration = OptionsStore.pollInterval,
        defaults: UserDefaults = .standard,
        now: @escaping @MainActor () -> Date = Date.init
    ) {
        self.client = client
        self.cache = cache
        self.makeSeriesCache = makeSeriesCache ?? { key in
            DiskCache<SeriesPayload>(key: key, ttl: CacheTTL.formingDailySeries)
        }
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
        self.pollInterval = pollInterval
        self.now = now
        self.defaults = defaults
        self.range = OptionsChartRange.remembered(in: defaults)
    }

    // MARK: - Derived state

    /// Filter, then sort, in the SAME pass that reads the payload — so the
    /// order tracks every response by construction (the web's rule). The
    /// comparator sees RAW decimal strings only; `price` and `pl.text` never
    /// reach it (non-negotiable #1). `expired` comes from the server's NY
    /// calendar and is never re-derived from the device clock.
    var visibleItems: [OptionCardItem] {
        guard let payload else { return [] }
        let filtered = showExpired ? payload.items : payload.items.filter { !$0.expired }
        return sortOptionCards(filtered, by: sort)
    }

    /// The summary and the list it describes always cover the same set — a
    /// hidden lot must never sit inside a shown total.
    var visibleSummary: LiveSummary? {
        guard let payload else { return nil }
        return showExpired ? payload.allSummary : payload.summary
    }

    var visibleSummaryNotes: [String] {
        guard let payload else { return [] }
        return showExpired ? payload.allSummaryNotes : payload.summaryNotes
    }

    var expiredCount: Int { payload?.expiredCount ?? 0 }

    /// Contracts exist but every one of them is hidden — said in words rather
    /// than shown as an empty grid under a live market bar.
    var allHidden: Bool {
        guard let payload else { return false }
        return !payload.items.isEmpty && visibleItems.isEmpty
    }

    func card(forKey key: String) -> OptionCardItem? {
        payload?.items.first { $0.key == key }
    }

    // MARK: - Lifecycle

    func start() async {
        hasStarted = true
        stale.connectivityChanged(to: isConnected())

        // From disk first. The tab opened on a spinner every time, and offline
        // that spinner resolved into an error screen about a book the app was
        // perfectly capable of drawing.
        if payload == nil, let cached = cache.read() {
            payload = cached.value
            stale.restored(from: cached.capturedAt)
            isLoading = false
        }
        // Only THIS range's file. Another range's series is not a stand-in,
        // and there is no file it could be read from by mistake.
        if seriesRange != range, let cachedSeries = seriesCache(for: range).read() {
            series = cachedSeries.value
            seriesRange = range
        }
        // `refresh()` revives the pump itself when it finds one dead — see the
        // comment inside `refresh()` — so no separate call is needed here.
        await refresh()
        // Whenever the drawn series is not the selected range's — not merely
        // when there is none — or the chart would stay on `.loading` forever.
        if seriesRange != range { await loadSeries() }
    }

    /// The cache for one range: the range is part of the question the
    /// payload answers, so it is part of the key.
    private func seriesCache(for range: OptionsChartRange) -> any PayloadCaching<SeriesPayload> {
        makeSeriesCache("options-series-\(range.rawValue)")
    }

    func refresh() async {
        guard let token = tokenProvider() else {
            // A transient Keychain miss, not necessarily a signed-out user
            // (see `MigratingTokenStore`). Returning here used to leave
            // `isLoading` stuck true forever — an infinite spinner with no
            // error and no way out, since only the two paths below it ever
            // clear that flag.
            #if DEBUG
                print("[options] refresh: no token available")
            #endif
            recordFailure()
            if hasStarted { resumePump() }
            isLoading = false
            return
        }

        do {
            let fresh = try await client.payload(token: token)
            payload = fresh
            let now = Date()
            stale.succeeded(at: now)
            cache.write(fresh, at: now)
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[options] refresh failed: \(error)")
            #endif
            recordFailure(error)
        }
        // Armed on BOTH branches, and that is the point: a first fetch that
        // failed — or a transient Keychain miss — used to leave the section
        // with no pump and no user-reachable retry, so it stayed frozen until
        // the app was backgrounded and reopened. It also revives a pump that
        // died for any other reason, which is what lets pull-to-refresh re-arm
        // polling — see `MarketStripStore.refresh()`, whose shape this is.
        // `resumePump()` cancels whatever is there first, so calling it every
        // time adds no second pump.
        if hasStarted { resumePump() }
        isLoading = false
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        // Only with nothing on screen. A failed refresh over a painted book is
        // staleness, which the bar says, not an outage, which this does.
        if payload == nil {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: OptionsStore.genericError
            )
        }
    }

    // MARK: - Connectivity

    /// See `LiveStore.connectivityChanged(to:)` — same contract, same reason.
    func connectivityChanged(to connected: Bool) {
        guard hasStarted, connected != stale.isConnected else { return }
        stale.connectivityChanged(to: connected)
        guard connected else { return }
        Task { await refresh() }
    }

    /// The chart is the OPTIONAL half: a book with no recorded marks yet is
    /// still a usable screen, so a failure here leaves the cards alone and
    /// never sets the screen's error.
    func loadSeries(ticker: String? = nil) async {
        guard let token = tokenProvider() else { return }
        let wanted = range
        let fresh = try? await client.series(range: wanted, ticker: ticker, token: token)
        // The range may have moved on while this was in flight; writing then
        // would draw one range's points under another's label, and two fast
        // taps would be settled by whichever answer arrived last.
        guard wanted == range else { return }
        guard let fresh else {
            // A failed REFRESH of the range already drawn leaves it — which,
            // since the cache below, may be the last one this app ever drew.
            // Blanking a real chart because a refresh missed is a worse
            // answer than an old chart under a bar that says how old.
            // A failed fetch for a range that has nothing of its own on
            // screen is different: the previous range's chart cannot stand
            // in for it, and the honest frame is the error one.
            if seriesRange != wanted {
                series = nil
                seriesRange = nil
                failedRange = wanted
            }
            return
        }
        series = fresh
        seriesRange = wanted
        failedRange = nil
        // Only the TAB's own chart is cached. `ticker` non-nil means this is
        // one contract's series for the detail screen, which is a different
        // question with its own answer, and writing it here would leave the
        // tab charting a single contract after a back navigation — the same
        // trap `contractSeries` was split out to avoid.
        if ticker == nil { seriesCache(for: wanted).write(fresh) }
    }

    /// ONE contract's series, for the detail screen. Returned rather than
    /// stored: the tab's own chart is the whole book, and writing this into
    /// `series` would leave the tab charting a single contract after a back
    /// navigation.
    func contractSeries(ticker: String, range: OptionsChartRange) async -> SeriesPayload? {
        guard let token = tokenProvider() else { return nil }
        return try? await client.series(range: range, ticker: ticker, token: token)
    }

    func scenePhaseChanged(toActive active: Bool) {
        guard hasStarted else { return }
        if active {
            Task {
                await refresh()
            }
        } else {
            // The whole point of the gate: a backgrounded app polls nothing.
            pump?.cancel()
            pump = nil
        }
    }

    // MARK: - Writes

    func add(_ body: OptionAddRequest) async -> Bool {
        guard let token = tokenProvider() else { return false }
        do {
            try await client.add(body, token: token)
            await refresh()
            await loadSeries()
            return true
        } catch let APIError.http(_, message) {
            errorMessage = message ?? "Could not add that contract."
            return false
        } catch {
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not add that contract."
            ) ?? "Could not add that contract."
            return false
        }
    }

    func update(_ body: OptionEditRequest) async -> Bool {
        guard let token = tokenProvider() else { return false }
        do {
            try await client.update(body, token: token)
            await refresh()
            return true
        } catch let APIError.http(_, message) {
            errorMessage = message ?? "Could not save that change."
            return false
        } catch {
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not save that change."
            ) ?? "Could not save that change."
            return false
        }
    }

    /// Removal addresses a LOT, never a card: a card can stand for several
    /// purchases, and removing "the card" would delete a purchase the user did
    /// not name. Idempotent on the server, so a second tap is a no-op.
    func remove(lotID: String) async {
        guard let token = tokenProvider() else { return }
        do {
            try await client.remove(lotID: lotID, token: token)
            await refresh()
            await loadSeries()
        } catch {
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not remove that purchase."
            ) ?? "Could not remove that purchase."
        }
    }

    func dismissError() { errorMessage = nil }

    func purge() {
        pump?.cancel()
        pump = nil
        hasStarted = false
        payload = nil
        series = nil
        seriesRange = nil
        failedRange = nil
        cache.clear()
        for each in OptionsChartRange.allCases { seriesCache(for: each).clear() }
        isLoading = true
        errorMessage = nil
        stale.reset()
    }

    // MARK: - The pump

    /// Arms the loop UNCONDITIONALLY — the market gate lives inside
    /// `runPump`, checked once per tick, and nowhere else.
    ///
    /// Gating the arming as well used to look like belt and braces and was
    /// actually the bug: with the market shut, no loop existed, so nothing was
    /// left running to notice the open. A phone left on the desk across the
    /// morning bell showed the previous close on the Dashboard's options row
    /// and on the Options tab for the rest of the day, and `StaleState` still
    /// called it fresh because the last fetch really had succeeded. A sleeping
    /// loop costs one date comparison a minute; the "zero requests while
    /// everything is shut" promise is kept by the guard sitting BEFORE
    /// `refresh()`, not by there being no loop.
    private func resumePump() {
        pump?.cancel()
        pump = Task { [weak self] in await self?.runPump() }
    }

    /// The market gate, ported from `use-options-poll.ts`.
    ///
    /// `pollingResumesAtMs` is non-nil only while EVERY session — regular and
    /// extended — is shut, so polling before that instant just asks the vendor
    /// to restate a frozen close.
    ///
    /// Compared in INTEGER milliseconds, matching `MarketStatusBar` — which
    /// is what the wire field already is, and which keeps a float conversion
    /// out of the file entirely. CI greps for those (non-negotiable #1) and
    /// the grep is deliberately blunt: a timestamp is not money, but a rule
    /// that needs a human to judge each hit is a rule that stops being
    /// enforced.
    private var pollingWorthwhile: Bool {
        guard let resumesAt = payload?.market.pollingResumesAtMs else { return true }
        return Int(now().timeIntervalSince1970 * 1000) >= resumesAt
    }

    private func runPump() async {
        while !Task.isCancelled {
            // 60 s normally; wider once requests start failing, and a flat
            // 30 s idle while the OS says there is no route — see
            // `LiveStore.poll()` for the reasoning this shares.
            let wait = stale.isConnected
                ? Backoff.delay(after: stale.consecutiveFailures, base: pollInterval)
                : Backoff.whileDisconnected
            try? await Task.sleep(for: wait)
            if Task.isCancelled { return }

            stale.connectivityChanged(to: isConnected())
            guard stale.shouldAttempt else { continue }
            // Re-checked every tick rather than once at arming time: the
            // market closes while the app is open, and a pump that only
            // asked at the start would run all night. `continue`, never
            // `return` — the market also OPENS while the app is open, and a
            // loop that exited here could only be revived by a scene-phase or
            // connectivity event that may never come.
            //
            // The gating promise is unchanged. While every session is shut —
            // outside market hours, at weekends and on holidays — the loop
            // wakes once a minute, compares two integers and fetches NOTHING;
            // and while the app is BACKGROUNDED it does not even do that,
            // because `scenePhaseChanged(toActive: false)` cancels the task
            // outright and `hasStarted` keeps a never-opened store cold.
            // Foreground visibility plus an open session remains the only
            // state in which a request leaves the device.
            guard pollingWorthwhile else { continue }
            await refresh()
        }
    }

    /// 60 s, matching `POLL_INTERVAL_MS` on the web. Tighter buys nothing: the
    /// figures are 15 minutes delayed at the source.
    static let pollInterval: Duration = .seconds(60)
}
