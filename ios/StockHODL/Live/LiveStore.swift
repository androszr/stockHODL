import Foundation
import Observation

enum HoldingsEmptiness: Equatable {
    case notEmpty
    case accountEmpty
    case scopeEmpty(portfolioName: String)
}

/// Everything the Holdings screen reads, and the only place that decides when
/// the network is allowed to be touched.
///
/// `@Observable` rather than `ObservableObject` for the reason in plan A.7:
/// SwiftUI invalidates per property READ, so a card that renders one holding's
/// price does not re-render because a different holding ticked. That is the
/// whole class of problem `ticker-tile-equal.ts` and `holding-card-equal.ts`
/// exist to solve on the web, and here it goes away structurally rather than
/// being solved again.
@MainActor
@Observable
final class LiveStore {
    /// The static half — names, quantities, cost basis — which changes only
    /// when the user edits transactions, and the scopes to choose between.
    private(set) var bootstrap: BootstrapResponse?
    /// The live half. Replaced wholesale on every tick; views read fields.
    private(set) var live: LivePayload?
    /// Which portfolio (or "all") is on screen. The client SELECTS a scope
    /// from what the payload already carries — it never asks the server for
    /// one, because a client-supplied scope is a client-supplied query.
    var selectedScopeID: String? {
        didSet { if oldValue != selectedScopeID { persistScope() } }
    }

    /// Everything the screen needs to decide whether it may claim the figures
    /// are current: when they were taken, whether the network has confirmed
    /// them, how many attempts have failed since, and what the OS thinks of
    /// the radio. It used to be three loose properties and a counter here, and
    /// the identical three in `WatchlistStore` and `OptionsStore`.
    private(set) var stale = StaleState()

    /// When the currently displayed data was actually received. Drives the
    /// staleness bar.
    var capturedAt: Date? { stale.capturedAt }
    /// Whether the screen owes the user a disclosure. See `Freshness` for the
    /// three positions this collapses.
    var isOffline: Bool { stale.isOffline }
    var freshness: Freshness { stale.freshness }

    /// True until the first paint from any source — cache or network. A
    /// snapshot makes this false immediately, which is the entire point of
    /// keeping one.
    private(set) var isLoading = true
    private(set) var errorMessage: String?

    static let genericError = "Could not load your portfolio."

    private let client: LiveClient
    private let snapshots: any SnapshotStoring
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio, injected the same way the token is.
    ///
    /// A closure rather than a reference to `Reachability.shared`, for the
    /// reason every other dependency here is injected: a test that had to
    /// stand up an `NWPathMonitor` would be testing Network.framework. The
    /// default is "connected", so every existing caller and fake behaves
    /// exactly as it did before this parameter existed.
    private let isConnected: @MainActor () -> Bool
    /// Injected rather than reached for, because `UserDefaults.standard` is
    /// process-wide state: two tests sharing it means whichever ran first
    /// decides what the second one opens on, and the failure surfaces as an
    /// unrelated assertion months later.
    private let defaults: UserDefaults

    /// The single live task — stream or poll — so a scene change cannot leave
    /// two cadences running against each other.
    private var pump: Task<Void, Never>?
    /// Whether this store has ever been asked for data. The scene wiring lives
    /// in the shell now, above every tab, and the shell must not wake a store
    /// nobody has opened — see `SignedInView`.
    private(set) var hasStarted = false

    init(
        client: LiveClient,
        snapshots: any SnapshotStoring,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        defaults: UserDefaults = .standard
    ) {
        self.client = client
        self.snapshots = snapshots
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
        self.defaults = defaults
    }

    // MARK: - Scopes

    /// The scope tabs: "All" first, then each portfolio in its own order.
    ///
    /// Built from `bootstrap.portfolios`, which is the user's whole set —
    /// including a portfolio holding nothing yet. An earlier version joined
    /// against `bootstrap.scopes` (composed only for portfolios with rows) and
    /// silently dropped empty ones, so a portfolio just created on the phone
    /// had no chip to select and no way to be renamed or deleted. An empty
    /// portfolio still deserves a chip; it is where the next transaction goes.
    var scopeChips: [ScopeChip] {
        guard let bootstrap else { return [] }
        var chips: [ScopeChip] = [ScopeChip(id: LiveStore.allScopeID, name: "All", txCount: nil)]
        for portfolio in bootstrap.portfolios.sorted(by: { $0.sortOrder < $1.sortOrder }) {
            chips.append(ScopeChip(id: portfolio.id, name: portfolio.name, txCount: portfolio.txCount))
        }
        return chips
    }

    /// Every portfolio id in display order — what a reorder rewrites. "All" is
    /// not one of them: it is a view of the set, not a member of it.
    var orderedPortfolioIDs: [String] {
        scopeChips.dropFirst().map(\.id)
    }

    /// The selected portfolio, or nil on "All". The management row is drawn
    /// only when this is non-nil, so the daily-glance view carries no
    /// management chrome at all — the web's rule.
    var selectedPortfolio: ScopeChip? {
        guard let id = selectedScopeID, id != LiveStore.allScopeID else { return nil }
        return scopeChips.first { $0.id == id }
    }

    static let allScopeID = "all"

    /// The rows and totals for whatever is selected. "All" is the payload's own
    /// top level rather than a client-side sum: totals cross currencies through
    /// FX the server already applied, and re-adding them here would be a second
    /// money implementation — precisely what non-negotiable #1 forbids.
    var visibleHoldings: [LiveHolding] {
        guard let live else { return [] }
        guard let id = selectedScopeID, id != LiveStore.allScopeID else { return live.holdings }
        return live.scopes.first { $0.id == id }?.holdings ?? []
    }

    var holdingsEmptiness: HoldingsEmptiness {
        if !visibleHoldings.isEmpty { return .notEmpty }
        if let selectedPortfolio, !(live?.holdings.isEmpty ?? true) {
            return .scopeEmpty(portfolioName: selectedPortfolio.name)
        }
        return .accountEmpty
    }

    var visibleSummary: LiveSummary? {
        guard let live else { return nil }
        guard let id = selectedScopeID, id != LiveStore.allScopeID else { return live.summary }
        return live.scopes.first { $0.id == id }?.summary
    }

    /// The static half of a row, matched by instrument id. Two dictionaries
    /// would be faster; a portfolio is tens of rows, and the version that is
    /// obviously correct wins at this size.
    func staticHolding(for holding: LiveHolding) -> StaticHolding? {
        bootstrap?.staticHoldings.first { $0.instrumentId == holding.instrumentId }
    }

    // MARK: - Dashboard

    /// One row per holding, static identity plus the freshest live figures.
    struct DashboardTile {
        let statics: StaticHolding
        /// Absent until the live half has caught up with a newly added
        /// position — the tile renders its '—' fallbacks rather than vanishing.
        let live: LiveHolding?
    }

    /// EVERY holding, deliberately ignoring `selectedScopeID`: the Dashboard
    /// is the whole portfolio's mood and the web's Dashboard has no scope at
    /// all. Driven from the STATIC half so a position whose live row has not
    /// arrived yet still gets a tile — the reverse of `visibleHoldings`, which
    /// is driven by the live half because a scope's membership is a live fact.
    var tiles: [DashboardTile] {
        guard let bootstrap else { return [] }
        let liveByID = Dictionary(
            (live?.holdings ?? []).map { ($0.instrumentId, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return bootstrap.staticHoldings.map {
            DashboardTile(statics: $0, live: liveByID[$0.instrumentId])
        }
    }

    // MARK: - Lifecycle

    /// Paint from disk, then go to the network. Called once when the screen
    /// appears; safe to call again.
    func start() async {
        hasStarted = true
        stale.connectivityChanged(to: isConnected())
        if let snapshot = snapshots.read(), bootstrap == nil {
            bootstrap = snapshot.bootstrap
            live = snapshot.bootstrap.live
            // `restored`, NOT `succeeded`: these figures came off a disk, and
            // until the network says otherwise the screen must admit it. The
            // old code set `capturedAt` here and left `isOffline` false, so a
            // cold launch with no signal painted yesterday's money with no
            // disclosure at all until TWO requests had timed out — roughly
            // forty seconds of quietly wrong prices.
            stale.restored(from: snapshot.capturedAt)
            isLoading = false
        }
        if selectedScopeID == nil { selectedScopeID = restoredScope() }

        // `refresh()` now revives the pump itself when it finds one dead, so
        // no separate call is needed here — see the comment inside `refresh()`.
        await refresh()
    }

    /// A full reload: both halves, CONCURRENTLY. Sequentially they would pay a
    /// cold Vercel function twice, and neither needs the other's answer.
    func refresh() async {
        guard let token = tokenProvider() else {
            // Not the same as being signed out: `tokenProvider` reads the
            // Keychain fresh every call, and that read can miss transiently
            // (see `MigratingTokenStore`). Silently returning here used to
            // leave `isLoading` stuck true forever with nothing on screen
            // ever explaining why — `recordFailure` is what every other
            // failure path already goes through, so this joins it instead of
            // inventing a second dead end.
            #if DEBUG
                print("[live] refresh: no token available")
            #endif
            recordFailure()
            return
        }

        async let bootstrapTask = client.bootstrap(token: token)
        async let liveTask = client.live(token: token)

        // The two halves are not equally load-bearing. `/bootstrap` already
        // carries a live payload; the separate `/live` call only buys a fresher
        // one. Awaiting them as a tuple let the optimization veto the data —
        // one 404 on `/live` blanked a screen the other call could have filled.
        let freshLive = try? await liveTask

        do {
            let fresh = try await bootstrapTask
            apply(bootstrap: fresh, live: freshLive ?? fresh.live)
            // A `refresh()` that lands with the pump already dead — a Keychain
            // miss on launch, a stream that fell through without reconnecting —
            // must revive it here. `resumePump()` always cancels whatever task
            // is there first, so calling it unconditionally is safe whether the
            // old pump is still running, has quietly finished, or was never
            // started; `pump` is never reset to nil by `runPump()` itself, so a
            // nil-check here would miss the "finished but not cleared" case.
            // Pull-to-refresh only ever calls `refresh()` — without this, it
            // would keep fetching one fresh snapshot forever without ever
            // restoring the live cadence, which is exactly the bug this fixes.
            if hasStarted {
                resumePump()
            }
        } catch {
            #if DEBUG
                print("[live] refresh failed: \(error)")
            #endif
            recordFailure(error)
        }
    }

    // MARK: - Connectivity

    /// The radio changed. Called by the shell for every store it has started,
    /// the same way `scenePhaseChanged` is.
    ///
    /// A route COMING BACK is the edge that matters. Before this, nothing in
    /// the process was listening: a phone that regained signal kept showing
    /// whatever it had until the user backgrounded the app or pulled to
    /// refresh, because the only two things that ever restarted a load were
    /// those. Losing the route matters less but is not nothing — it repaints
    /// the bar with a cause instead of leaving it counting timeouts.
    func connectivityChanged(to connected: Bool) {
        guard hasStarted, connected != stale.isConnected else { return }
        stale.connectivityChanged(to: connected)
        guard connected else {
            // Let the pump notice on its own next loop rather than cancelling
            // it here: an `.unsatisfied` path that lasts two seconds is a
            // Wi-Fi-to-cellular handover, and tearing down a live stream for
            // one would reconnect more often than it saved.
            return
        }
        Task { await refresh() }
    }

    private func apply(bootstrap fresh: BootstrapResponse, live freshLive: LivePayload) {
        bootstrap = fresh
        live = freshLive
        stale.succeeded(at: Date())
        isLoading = false
        errorMessage = nil
        // The snapshot stores the bootstrap with the FRESHER live half spliced
        // in, so the next cold start paints the newest prices this app ever
        // saw rather than the ones that happened to ride along with the static
        // data.
        snapshots.write(Snapshot(bootstrap: fresh.replacingLive(freshLive), capturedAt: Date()))
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        // A failure with something already on screen is a staleness problem,
        // not an error to shout about. With nothing on screen it is the only
        // thing we can say — and WHICH thing depends on whether the radio is
        // the problem, because "Could not load your portfolio" under a Try
        // again button is the app blaming itself for a tunnel.
        if bootstrap == nil {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: LiveStore.genericError
            )
            isLoading = false
        }
    }

    // MARK: - The pump

    /// Foreground: stream if the market is running, otherwise nothing at all.
    /// Background: nothing, unconditionally.
    func scenePhaseChanged(toActive active: Bool) {
        guard hasStarted else { return }
        if active {
            Task {
                // A fresh REST baseline BEFORE reconnecting: whatever happened
                // while the app was away, the stream only sends changes from
                // now on and would otherwise leave the gap on screen. `refresh()`
                // revives the pump itself once the baseline lands.
                await refresh()
            }
        } else {
            pump?.cancel()
            pump = nil
        }
    }

    private func resumePump() {
        pump?.cancel()
        guard let live, PollPolicy.shouldPoll(live) else {
            pump = nil
            return
        }
        pump = Task { [weak self] in await self?.runPump() }
    }

    /// Stream first, poll as the fallback the server itself asks for.
    ///
    /// A clean end of stream is NOT an error: Vercel caps the function, so the
    /// stream ending is the ordinary case and means reconnect. `idle` and `bye`
    /// mean stop, and the pump exits — the next scene activation or the user's
    /// own pull-to-refresh starts it again.
    private func runPump() async {
        guard let token = await resolveToken() else {
            #if DEBUG
                print("[live] runPump: giving up, no token after retries")
            #endif
            return
        }

        while !Task.isCancelled {
            var fellBack = false

            do {
                for try await event in client.stream(token: token) {
                    if Task.isCancelled { return }
                    switch event {
                    case let .payload(payload):
                        applyTick(payload)
                    case .idle:
                        return
                    case .fallback:
                        fellBack = true
                    case .bye:
                        break
                    }
                    if fellBack { break }
                }
            } catch {
                #if DEBUG
                    print("[live] stream failed: \(error)")
                #endif
                // Counted, not just noted. The backoff above reads this
                // counter, and a stream that dies instantly and repeatedly —
                // exactly what no-route looks like — used to leave it at zero
                // and reconnect at full speed forever.
                recordFailure(error)
                fellBack = true
            }

            if Task.isCancelled { return }

            if fellBack {
                await poll(token: token)
                return
            }

            // Clean end — reconnect, but never in a tight loop if the server
            // is refusing instantly, and never at all while there is no route
            // to refuse it. A stream that ends the instant it opens is what a
            // dead radio looks like from in here, and one second between
            // attempts is a reconnect storm.
            try? await Task.sleep(
                for: stale.isConnected
                    ? Backoff.delay(after: stale.consecutiveFailures, base: .seconds(1))
                    : Backoff.whileDisconnected
            )
            stale.connectivityChanged(to: isConnected())
            guard let live, PollPolicy.shouldPoll(live) else { return }
        }
    }

    /// A Keychain read can miss transiently — a mis-provisioned access group,
    /// a query racing app launch (`MigratingTokenStore`'s own reasoning for
    /// why it falls back rather than throws). `runPump` used to take that
    /// single miss as final and die for the rest of the session with nothing
    /// on screen ever moving again and not one line printed to explain why.
    /// Retrying a few seconds is cheap insurance against exactly that.
    private func resolveToken() async -> String? {
        for attempt in 0..<5 {
            if let token = tokenProvider() { return token }
            #if DEBUG
                print("[live] runPump: no token, attempt \(attempt + 1)/5")
            #endif
            if Task.isCancelled { return nil }
            try? await Task.sleep(for: .seconds(2))
        }
        return nil
    }

    /// The REST cadence. Runs only while the policy still says the market is
    /// live and there is something pollable — a closed market means zero
    /// requests, which is what the battery and the function bill are for.
    private func poll(token: String) async {
        while !Task.isCancelled {
            guard let live, PollPolicy.shouldPoll(live) else { return }

            // The cadence widens as failures accumulate, and stops asking
            // altogether while the OS says there is no route. Before this the
            // loop fired every 10 s no matter what, so a phone in a tunnel
            // issued a request every ten seconds that then held the radio open
            // for the full 20-second timeout — a live screen turning into a
            // battery complaint, invisible on a desk where the requests
            // succeed.
            let wait = stale.isConnected
                ? Backoff.delay(after: stale.consecutiveFailures, base: PollPolicy.interval)
                : Backoff.whileDisconnected
            try? await Task.sleep(for: wait)
            if Task.isCancelled { return }

            // Re-read the radio rather than trusting the value we slept on:
            // half a minute is long enough for a train to leave a tunnel, and
            // the `Reachability` edge may have fired while this task slept.
            stale.connectivityChanged(to: isConnected())
            guard stale.shouldAttempt else { continue }

            do {
                applyTick(try await client.live(token: token))
            } catch {
                recordFailure(error)
            }
        }
    }

    /// A price tick updates the live half only. The static half is untouched —
    /// nothing about a quote changes what the user owns.
    private func applyTick(_ payload: LivePayload) {
        live = payload
        stale.succeeded(at: Date())
        if let bootstrap {
            snapshots.write(Snapshot(bootstrap: bootstrap.replacingLive(payload), capturedAt: Date()))
        }
    }

    // MARK: - Sign-out

    /// Purge everything derived from the account. Called by sign-out, which
    /// already purges the token — leaving a portfolio on disk after a sign-out
    /// would be the same mistake one layer down.
    func purge() {
        pump?.cancel()
        pump = nil
        hasStarted = false
        snapshots.clear()
        bootstrap = nil
        live = nil
        stale.reset()
        isLoading = true
        errorMessage = nil
    }

    // MARK: - Scope persistence

    /// Which tab was open last, remembered across launches. `UserDefaults`
    /// rather than the snapshot: it is a UI preference, not account data, and
    /// it must survive the purge above being called for an unrelated reason.
    private static let scopeKey = "holdings.selectedScope"

    private func persistScope() {
        defaults.set(selectedScopeID, forKey: LiveStore.scopeKey)
    }

    private func restoredScope() -> String {
        defaults.string(forKey: LiveStore.scopeKey) ?? LiveStore.allScopeID
    }
}

extension BootstrapResponse {
    /// The generated contracts are immutable `let`s — deliberately, they mirror
    /// a wire format — so refreshing the live half means rebuilding the value.
    func replacingLive(_ live: LivePayload) -> BootstrapResponse {
        BootstrapResponse(
            live: live,
            portfolios: portfolios,
            scopes: scopes,
            staticHoldings: staticHoldings,
            watchlist: watchlist
        )
    }
}
