import Foundation
import Observation

/// How the equity holdings have actually done, and where the money sits.
///
/// A read-only store for a screen opened occasionally, so it is deliberately
/// as dumb as the dividends one: no poll, no stream. It loads when the
/// screen appears, on pull-to-refresh, and when a scope chip is tapped.
///
/// It keeps a disk cache, per scope: All and one portfolio are different
/// answers, and a shared file would let a scoped view paint as if it were
/// everything. Cached on the daily-series TTL — the walk is over immutable
/// closes plus today's quotes, and the stale bar is what admits the quotes
/// have moved.
///
/// Nothing here folds money. XIRR, TWRR, the PLN tiles, the allocation
/// percents and the rebased lines all arrive already computed, on Decimal,
/// from the ONE walk in `src/lib/analytics/view.ts` that the web page uses
/// too. A store that re-added a column would be a second opinion about
/// what the portfolio returned.
@Observable
@MainActor
final class AnalyticsStore {
    private(set) var view: AnalyticsResponse?

    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var hasLoaded = false

    /// The chip currently selected. Set as soon as a load is asked for, so
    /// the row does not lag behind the request. `"all"` is All — the same
    /// sentinel Holdings uses, so a scope id can never collide with it.
    private(set) var selectedScopeID = AnalyticsStore.allScopeID

    static let allScopeID = "all"
    static let genericError = "Could not load analytics."
    static let genericTargetsError = "Could not save the targets."
    static let genericTargetsRead = "Could not read the current targets — try again."

    /// Freshness, shared with every other store — see `StaleState`.
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    private let client: AnalyticsClient
    /// The targets door, used ONLY by the edit sheet. Optional so every test
    /// that builds a store for the read path stays a read-path test.
    private let targetsClient: TargetsClient?
    private let makeCache: @Sendable (String) -> any PayloadCaching<AnalyticsResponse>
    private let tokenProvider: @MainActor () -> String?
    private let isConnected: @MainActor () -> Bool

    init(
        client: AnalyticsClient,
        targetsClient: TargetsClient? = nil,
        makeCache: @escaping @Sendable (String) -> any PayloadCaching<AnalyticsResponse> = {
            DiskCache<AnalyticsResponse>(key: "analytics-\($0)", ttl: CacheTTL.dailySeries)
        },
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.client = client
        self.targetsClient = targetsClient
        self.makeCache = makeCache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
    }

    /// The scope the last load used, so a refresh asks for the SAME view
    /// rather than silently widening it to All.
    private var lastPortfolioId: String?

    func load(portfolioId: String? = nil) async {
        lastPortfolioId = portfolioId
        selectedScopeID = portfolioId ?? AnalyticsStore.allScopeID
        isLoading = true
        stale.connectivityChanged(to: isConnected())
        defer {
            isLoading = false
            hasLoaded = true
        }

        let cache = makeCache(portfolioId ?? "all")
        // Disk first, so the screen has figures before the request is made.
        // Reached from Holdings — a screen the user may well be looking at
        // on a train. Applied even when another scope is already on screen:
        // otherwise the chip would say Main while the tiles still showed All.
        if let cached = cache.read() {
            apply(cached.value)
            stale.restored(from: cached.capturedAt)
        }

        guard let token = tokenProvider() else {
            recordFailure()
            return
        }

        do {
            let response = try await client.load(portfolioId: portfolioId, token: token)
            apply(response)
            let now = Date()
            stale.succeeded(at: now)
            cache.write(response, at: now)
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[analytics] load failed: \(error)")
            #endif
            recordFailure(error)
        }
    }

    func reload() async {
        await load(portfolioId: lastPortfolioId)
    }

    private func apply(_ response: AnalyticsResponse) {
        view = response
        // The server is the source of the resolved scope — a stale chip
        // degrades to All inside `resolvePortfolioScope`, and the chips
        // have to land on what actually arrived.
        selectedScopeID = response.scopeId ?? AnalyticsStore.allScopeID
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        // Figures already on screen stay on screen: they were true a moment
        // ago, and blanking them to say "could not load" loses more than it
        // tells. The FIRST load has nothing to keep, so it says so.
        if view == nil {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: AnalyticsStore.genericError
            )
        }
    }

    // MARK: - Target weights

    /// The edit sheet's seed. Read from the SERVER rather than from `view`:
    /// the analytics payload can be minutes old off the disk cache, and a
    /// bulk replace built on stale seeds would silently clobber a target set
    /// elsewhere.
    /// Answers the saved rows, or the sentence to show. A tuple rather than
    /// `Result`: the failure is a sentence for the user, and `String` is not
    /// an `Error`.
    func fetchTargets(portfolioId: String) async -> (rows: [TargetRow], failure: String?) {
        guard let targetsClient, let token = tokenProvider() else {
            return ([], AnalyticsStore.genericTargetsRead)
        }
        do {
            let response = try await targetsClient.get(portfolioId: portfolioId, token: token)
            return (response.rows, nil)
        } catch {
            #if DEBUG
                print("[analytics] targets read failed: \(error)")
            #endif
            return (
                [],
                LoadFailure.message(
                    for: error,
                    connected: isConnected(),
                    generic: AnalyticsStore.genericTargetsRead
                )
            )
        }
    }

    /// Replace the whole list, then reload so the card repaints from the
    /// server's just-invalidated view rather than from what the sheet
    /// believes. Answers the sentence to show, or nil on success.
    func saveTargets(portfolioId: String, rows: [TargetPutRow]) async -> String? {
        guard let targetsClient, let token = tokenProvider() else {
            return AnalyticsStore.genericTargetsError
        }
        do {
            try await targetsClient.put(portfolioId: portfolioId, rows: rows, token: token)
        } catch let APIError.http(_, message) {
            // The server's own words — "Unknown instrument." and the
            // validation bounds read better than anything restated here.
            return message ?? AnalyticsStore.genericTargetsError
        } catch {
            #if DEBUG
                print("[analytics] targets save failed: \(error)")
            #endif
            // Writes are online-only, and one that never left the device says
            // so rather than reading as a refusal.
            return LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: AnalyticsStore.genericTargetsError
            ) ?? AnalyticsStore.genericTargetsError
        }

        await reload()
        return nil
    }

    func dismissError() {
        errorMessage = nil
    }

    func purge() {
        view = nil
        errorMessage = nil
        hasLoaded = false
        selectedScopeID = AnalyticsStore.allScopeID
        lastPortfolioId = nil
        stale.reset()
    }
}
