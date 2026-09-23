import Foundation
import Observation

/// The Dashboard's market index strip — S&P 500, Nasdaq and Dow, each via the
/// ETF that tracks it.
///
/// `OptionsStore`'s pattern, trimmed to a store that only ever reads: POLL
/// ONLY at 60 s, gated on the app being FOREGROUND and on the market being
/// open or about to be. Both halves of that gate are load-bearing — without
/// them a phone in a pocket over a weekend issues ~1,440 requests a day for
/// three frozen closes, which is the exact bug the options gate records
/// having fixed.
///
/// A `DiskCache` under Caches, not the App Group container: no widget draws
/// this, and the container is for the one payload a widget reads (the
/// watchlist's reasoning verbatim). Cold offline launch therefore paints the
/// last strip immediately, marked UNCONFIRMED — `StaleState.restored(from:)`
/// is what stops a disk read from being indistinguishable from a fresh fetch.
///
/// It shares no type with `LiveStore`: the strip is a third parallel delivery
/// on the server too, and merging them would quietly widen the holdings
/// vendor batch with three symbols nobody holds.
@MainActor
@Observable
final class MarketStripStore {
    private(set) var payload: MarketStripPayload?
    private(set) var isLoading = true

    /// Shared freshness bookkeeping rather than a fourth private copy.
    private(set) var stale = StaleState()

    var freshness: Freshness { stale.freshness }

    /// The tiles, or none. Deliberately NOT an error surface: the strip is
    /// decoration above someone's money, and a failed fetch must never take
    /// the Dashboard's own figures down with it — the row simply stays absent
    /// (first run) or stays painted with the staleness caption (afterwards).
    var tiles: [IndexTile] { payload?.tiles ?? [] }

    /// The USD/PLN tile, or nil before the first payload. Same non-error
    /// stance as `tiles`.
    ///
    /// Refreshed on the SAME cadence as the index tiles — the poll gate is
    /// the US market's, so the rate updates while the US market is open or
    /// about to open, plus every foreground and pull-to-refresh. Not around
    /// the clock: widening the gate for one tile is the all-night polling
    /// bug the class comment above records, and a currency's overnight drift
    /// is not worth 1,440 requests a day.
    var fx: CurrencyTile? { payload?.fx }

    /// The header facts for one tile, by key — what the market detail screen
    /// draws above its chart, read from THIS store so it repaints on the
    /// strip's cadence with no second quote fetch. Nil for a key the payload
    /// does not carry (an older server, or nothing loaded yet).
    func tile(for key: MarketTileKey) -> MarketTileHeader? {
        guard let payload else { return nil }
        if key == .usdpln {
            let fx = payload.fx
            return MarketTileHeader(
                title: fx.pairLabel,
                caption: fx.caption,
                last: fx.last,
                dayPct: fx.dayPct
            )
        }
        guard let tile = payload.tiles.first(where: { $0.key == key }) else { return nil }
        return MarketTileHeader(
            title: tile.indexName,
            caption: "via \(tile.proxySymbol)",
            last: tile.last,
            dayPct: tile.dayPct
        )
    }

    private let client: MarketStripClient
    private let cache: any PayloadCaching<MarketStripPayload>
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio — injected, see `LiveStore`.
    private let isConnected: @MainActor () -> Bool
    /// The cadence between ticks. Injected ONLY so a test can watch the gate
    /// close and reopen without waiting a real minute; production always gets
    /// `MarketStripStore.pollInterval`.
    private let pollInterval: Duration
    /// The wall clock the market gate reads. Injected ONLY so a test can hold
    /// the gate shut and then open it deterministically, instead of racing a
    /// real sleep against the real resume instant; production always gets
    /// `Date.init`.
    private let now: @MainActor () -> Date
    private var pump: Task<Void, Never>?

    /// Whether the Dashboard has ever been opened. A store nobody has opened
    /// must stay cold: coming back to the foreground must not fetch for a tab
    /// the user has never looked at.
    private(set) var hasStarted = false

    init(
        client: MarketStripClient,
        cache: any PayloadCaching<MarketStripPayload> = DiskCache<MarketStripPayload>(
            key: "market-strip",
            ttl: CacheTTL.quotes
        ),
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        pollInterval: Duration = MarketStripStore.pollInterval,
        now: @escaping @MainActor () -> Date = Date.init
    ) {
        self.client = client
        self.cache = cache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
        self.pollInterval = pollInterval
        self.now = now
    }

    // MARK: - Lifecycle

    func start() async {
        hasStarted = true
        stale.connectivityChanged(to: isConnected())

        // From disk first, so a cold launch in a tunnel paints the row rather
        // than a gap. `restored(from:)` marks it unconfirmed — the caption
        // below the row says how old it is until a fetch actually lands.
        if payload == nil, let cached = cache.read() {
            payload = cached.value
            stale.restored(from: cached.capturedAt)
            isLoading = false
        }

        await refresh()
    }

    func refresh() async {
        guard let token = tokenProvider() else {
            // A transient Keychain miss is not necessarily a signed-out user
            // (see `MigratingTokenStore`). Clearing `isLoading` here is what
            // stops the row from holding a skeleton forever.
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
        } catch {
            #if DEBUG
                print("[market-strip] refresh failed: \(error)")
            #endif
            recordFailure()
        }
        // Armed on BOTH branches, and that is the point: a first fetch that
        // failed used to leave the row absent with no pump and no
        // user-reachable retry, so the strip stayed missing until the app was
        // backgrounded and reopened. `resumePump()` cancels whatever is there
        // first, so calling it every time adds no second pump.
        if hasStarted { resumePump() }
        isLoading = false
    }

    private func recordFailure() {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
    }

    /// See `LiveStore.connectivityChanged(to:)` — same contract, same reason.
    func connectivityChanged(to connected: Bool) {
        guard hasStarted, connected != stale.isConnected else { return }
        stale.connectivityChanged(to: connected)
        guard connected else { return }
        Task { await refresh() }
    }

    func scenePhaseChanged(toActive active: Bool) {
        guard hasStarted else { return }
        if active {
            Task { await refresh() }
        } else {
            // The whole point of the gate: a backgrounded app polls nothing.
            pump?.cancel()
            pump = nil
        }
    }

    func purge() {
        pump?.cancel()
        pump = nil
        hasStarted = false
        payload = nil
        cache.clear()
        isLoading = true
        stale.reset()
    }

    // MARK: - The pump

    /// Arms the loop UNCONDITIONALLY — the market gate lives inside `runPump`,
    /// checked once per tick, and nowhere else.
    ///
    /// Gating the arming as well used to look like belt and braces and was
    /// actually the bug: with the market shut, no loop existed, so nothing was
    /// left running to notice the open. A user holding the app across the
    /// pre-market bell saw the previous close for the rest of the day, and
    /// `StaleState` still called it fresh because the last fetch really had
    /// succeeded. A sleeping loop costs one date comparison a minute; the
    /// "zero requests while everything is shut" promise is kept by the guard
    /// sitting BEFORE `refresh()`, not by there being no loop.
    private func resumePump() {
        pump?.cancel()
        pump = Task { [weak self] in await self?.runPump() }
    }

    /// The market gate. The predicate is the options store's; the loop around
    /// it deliberately is NOT — `runPump` continues past a shut gate where
    /// `OptionsStore` returns, which is what lets this store wake at the open
    /// while the app stays foregrounded.
    ///
    /// `pollingResumesAtMs` is non-nil only while EVERY session — regular and
    /// extended — is shut, so asking before that instant only makes the vendor
    /// restate a frozen close. Compared in INTEGER milliseconds, which is what
    /// the wire field already is and what keeps a float conversion out of this
    /// file entirely (non-negotiable #1's blunt CI grep).
    private var pollingWorthwhile: Bool {
        guard let resumesAt = payload?.market.pollingResumesAtMs else { return true }
        return Int(now().timeIntervalSince1970 * 1000) >= resumesAt
    }

    private func runPump() async {
        while !Task.isCancelled {
            let wait = stale.isConnected
                ? Backoff.delay(after: stale.consecutiveFailures, base: pollInterval)
                : Backoff.whileDisconnected
            try? await Task.sleep(for: wait)
            if Task.isCancelled { return }

            stale.connectivityChanged(to: isConnected())
            guard stale.shouldAttempt else { continue }
            // Re-checked every tick, not once at arming time: the market
            // closes while the app is open, and a pump that only asked at the
            // start would run all night. `continue`, never `return` — the
            // market also OPENS while the app is open, and a loop that exited
            // here could only be revived by a scene-phase or connectivity
            // event that may never come.
            guard pollingWorthwhile else { continue }
            await refresh()
        }
    }

    /// 60 s, matching the options cadence. Tighter buys nothing: the figures
    /// are 15 minutes delayed at the source and the spark grows one bar every
    /// five minutes.
    static let pollInterval: Duration = .seconds(60)
}

/// What a market tile says about itself above a chart: the title, the
/// disclosure under it (`via SPY` / `PLN per 1 USD`), the reading and the
/// day's move. Built from either tile shape so the detail screen has one
/// header, not two.
struct MarketTileHeader: Sendable {
    let title: String
    let caption: String
    let last: String?
    let dayPct: LiveFigure?
}
