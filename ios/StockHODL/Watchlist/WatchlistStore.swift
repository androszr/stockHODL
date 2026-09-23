import Foundation
import Observation

/// The watchlist screen.
///
/// The same shape as `LiveStore` — a static half, a live half, one pump — for
/// the same reasons, and deliberately NOT the same object: the server keeps
/// the two payloads parallel so that watched symbols never widen the holdings
/// vendor batch, and merging them here would quietly undo that.
///
/// One difference worth naming: the cache is a `DiskCache` under Caches, not
/// the App Group container. The container exists so a WIDGET can read the
/// holdings snapshot; nothing draws a watchlist widget, and putting purgeable
/// data somewhere the system will not purge it is the wrong trade. What it is
/// no longer is ABSENT — "a watchlist is cheap to refetch" was true of the
/// request and false of the experience: cheap or not, offline it fetched
/// nothing and the tab was a blank screen with a Try again button.
@MainActor
@Observable
final class WatchlistStore {
    private(set) var items: [WatchedItem] = []
    private(set) var live: WatchlistPayload?

    private(set) var isLoading = true
    private(set) var errorMessage: String?

    /// The freshness bookkeeping, shared with `LiveStore` and `OptionsStore`
    /// rather than reimplemented here for the third time.
    private(set) var stale = StaleState()

    var isOffline: Bool { stale.isOffline }
    var freshness: Freshness { stale.freshness }

    static let genericError = "Could not load your watchlist."

    private let client: WatchlistClient
    /// The membership list and the quotes that go with it, kept together:
    /// they are one screen, they are fetched together, and a cache that held
    /// only half would paint tickers with no figures beside them.
    private let cache: any PayloadCaching<CachedWatchlist>
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio. Injected and defaulted, exactly as in
    /// `LiveStore` — see the note there for why it is not read from
    /// `Reachability.shared` directly.
    private let isConnected: @MainActor () -> Bool
    private var pump: Task<Void, Never>?
    /// Whether this tab has ever been opened. The scene wiring lives in the
    /// shell now, above every tab, and a store nobody has opened must stay
    /// cold — otherwise coming back to the foreground would fetch three tabs
    /// the user never looked at.
    private(set) var hasStarted = false

    init(
        client: WatchlistClient,
        cache: any PayloadCaching<CachedWatchlist> = DiskCache<CachedWatchlist>(
            key: "watchlist",
            ttl: CacheTTL.quotes
        ),
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.client = client
        self.cache = cache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
    }

    /// The live figures for a row, matched by instrument id. Nil while the
    /// quotes are still in flight, which the tile renders as "—" rather than
    /// as a zero.
    func figures(for item: WatchedItem) -> LiveWatchItem? {
        live?.items.first { $0.instrumentId == item.instrumentId }
    }

    /// The grid's sections, in the SERVER's target-proximity order — the view
    /// must iterate these, never `items`, or the server sort is silently
    /// discarded. Pure join, pinned by `WatchlistSectionsTests`.
    var sections: [WatchlistSection] {
        WatchlistSections.build(items: items, live: live)
    }

    // MARK: - Lifecycle

    func start() async {
        hasStarted = true
        stale.connectivityChanged(to: isConnected())

        // Paint from disk BEFORE the network is touched, the way Holdings
        // does. The tab used to open on a spinner every single time, including
        // the times it was about to open on an error.
        if items.isEmpty, let cached = cache.read() {
            items = cached.value.items
            live = cached.value.quotes
            stale.restored(from: cached.capturedAt)
            isLoading = false
        }
        // `refresh()` revives the pump itself when it finds one dead — see the
        // comment inside `refresh()` — so no separate call is needed here.
        await refresh()
    }

    /// Membership and quotes concurrently — neither needs the other's answer.
    func refresh() async {
        guard let token = tokenProvider() else { return }

        async let itemsTask = client.items(token: token)
        async let quotesTask = client.quotes(token: token)

        // The quotes are the optional half: a list of tickers with no figures
        // is still a usable screen, and blanking it because the vendor is
        // having a bad minute would be the wrong trade.
        let freshQuotes = try? await quotesTask

        do {
            items = try await itemsTask
            if let freshQuotes { live = freshQuotes }
            let now = Date()
            stale.succeeded(at: now)
            cache.write(CachedWatchlist(items: items, quotes: live), at: now)
            errorMessage = nil
            // Revive the pump if it died — a Keychain miss, a stream that fell
            // through. `resumePump()` always cancels whatever task is there
            // first, so calling it unconditionally is safe; `pump` is never
            // reset to nil by `runPump()` itself, so a nil-check would miss a
            // pump that finished without being cleared. Pull-to-refresh only
            // ever calls `refresh()`, so without this it can never restore the
            // live cadence once the pump has died — see `LiveStore.refresh()`.
            if hasStarted {
                resumePump()
            }
        } catch {
            #if DEBUG
                print("[watchlist] refresh failed: \(error)")
            #endif
            stale.connectivityChanged(to: isConnected())
            stale.failed()
            if items.isEmpty {
                errorMessage = LoadFailure.message(
                    for: error,
                    connected: stale.isConnected,
                    generic: WatchlistStore.genericError
                )
            }
        }
        isLoading = false
    }

    func scenePhaseChanged(toActive active: Bool) {
        guard hasStarted else { return }
        if active {
            Task {
                await refresh()
            }
        } else {
            pump?.cancel()
            pump = nil
        }
    }

    // MARK: - Writes

    /// Add from a search result. Idempotent on the server's composite key, so
    /// re-adding an already-watched stock is a 200 and a no-op — the tile is
    /// simply already there.
    func add(_ match: SymbolMatch) async {
        guard let token = tokenProvider(), let body = WatchlistAddRequest(match) else {
            // The only way the body fails to build is an unmapped currency,
            // and inventing one would bind the symbol permanently.
            errorMessage = "That result is missing a currency — add it as a transaction instead."
            return
        }

        do {
            try await client.add(body, token: token)
            await refresh()
        } catch let APIError.http(_, message) {
            errorMessage = message ?? "Could not add that to your watchlist."
        } catch {
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not add that to your watchlist."
            ) ?? "Could not add that to your watchlist."
        }
    }

    func remove(_ item: WatchedItem) async {
        guard let token = tokenProvider() else { return }

        do {
            try await client.remove(instrumentId: item.instrumentId, token: token)
            items.removeAll { $0.instrumentId == item.instrumentId }
        } catch let APIError.http(status, _) where status == 404 {
            // Already gone — removed from the web, or a second tap. Drop it
            // rather than leave a row that cannot be removed.
            items.removeAll { $0.instrumentId == item.instrumentId }
        } catch {
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not remove that."
            ) ?? "Could not remove that."
        }
    }

    func dismissError() { errorMessage = nil }

    // MARK: - The pump

    private func resumePump() {
        pump?.cancel()
        guard stillPollable else {
            pump = nil
            return
        }
        pump = Task { [weak self] in await self?.runPump() }
    }

    /// Stream first, poll when the server asks for it, silence when the market
    /// is closed. A clean end of stream is the ordinary case on Vercel and
    /// means reconnect — see `LiveStore.runPump`, which this mirrors.
    private func runPump() async {
        guard let token = tokenProvider() else { return }

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
                    print("[watchlist] stream failed: \(error)")
                #endif
                // Counted, so the backoff below has something to read — see
                // `LiveStore.runPump()` for why an uncounted stream failure
                // reconnects at full speed forever.
                stale.connectivityChanged(to: isConnected())
                stale.failed()
                fellBack = true
            }

            if Task.isCancelled { return }

            if fellBack {
                await poll(token: token)
                return
            }

            try? await Task.sleep(
                for: stale.isConnected
                    ? Backoff.delay(after: stale.consecutiveFailures, base: .seconds(1))
                    : Backoff.whileDisconnected
            )
            stale.connectivityChanged(to: isConnected())
            guard stillPollable else { return }
        }
    }

    private func poll(token: String) async {
        while !Task.isCancelled {
            guard stillPollable else { return }

            // Widening cadence on failure, and none at all with no route —
            // the reasoning is written out in `LiveStore.poll()`.
            let wait = stale.isConnected
                ? Backoff.delay(after: stale.consecutiveFailures, base: PollPolicy.interval)
                : Backoff.whileDisconnected
            try? await Task.sleep(for: wait)
            if Task.isCancelled { return }

            stale.connectivityChanged(to: isConnected())
            guard stale.shouldAttempt else { continue }

            do {
                applyTick(try await client.quotes(token: token))
            } catch {
                // `try?` used to swallow this, which meant a quote poll could
                // fail for an hour without the bar ever appearing: the screen
                // kept the tickers it had and claimed their figures were
                // current.
                stale.failed()
            }
        }
    }

    private var stillPollable: Bool {
        guard let live else { return false }
        return PollPolicy.shouldPollQuotes(
            status: live.market.status,
            hasPollableSymbols: live.hasPollableSymbols
        )
    }

    private func applyTick(_ payload: WatchlistPayload) {
        live = payload
        let now = Date()
        stale.succeeded(at: now)
        // The tick carries the FRESHER quotes; the membership list is
        // unchanged, so it rides along rather than being refetched.
        cache.write(CachedWatchlist(items: items, quotes: payload), at: now)
    }

    // MARK: - Connectivity

    /// See `LiveStore.connectivityChanged(to:)` — same contract, same reason.
    func connectivityChanged(to connected: Bool) {
        guard hasStarted, connected != stale.isConnected else { return }
        stale.connectivityChanged(to: connected)
        guard connected else { return }
        Task { await refresh() }
    }

    func purge() {
        pump?.cancel()
        pump = nil
        hasStarted = false
        items = []
        live = nil
        cache.clear()
        stale.reset()
        isLoading = true
        errorMessage = nil
    }
}

/// The watchlist as it is written to disk.
///
/// A struct rather than caching the two halves separately, because they are
/// only meaningful together: a membership list with no quotes paints rows of
/// dashes, and quotes with no membership paint nothing at all. `quotes` is
/// optional because the server's two calls fail independently and a list with
/// no figures yet is still worth keeping.
struct CachedWatchlist: Codable, Sendable {
    let items: [WatchedItem]
    let quotes: WatchlistPayload?
}
