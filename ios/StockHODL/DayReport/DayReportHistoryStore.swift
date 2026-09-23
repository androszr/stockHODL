import Foundation
import Observation

/// The Dashboard's "Day reports" list: every report the server has written
/// for the all-portfolios scope, newest first, thirty at a time.
///
/// Same shape as `DayReportStore`: cache-first on `load()` (page one only —
/// an offline launch paints the last list it fetched, marked stale), then the
/// network replaces it; `loadMore()` appends older pages by the server's
/// keyset cursor and never touches the cache. Every figure on a row is the
/// server-formatted string the report stored when it was written — nothing
/// here parses or computes money.
@Observable
@MainActor
final class DayReportHistoryStore {
    private(set) var items: [DayReportHistoryItem] = []
    private(set) var nextCursor: String?
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var errorMessage: String?
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    static let cacheKey = "day-report-history"
    static let genericError = "Could not load past day reports."

    private let client: DayReportClient
    private let makeCache: @Sendable (String, TimeInterval) -> any PayloadCaching<DayReportHistoryResponse>
    private let tokenProvider: @MainActor () -> String?
    private let isConnected: @MainActor () -> Bool

    init(
        client: DayReportClient,
        makeCache: @escaping @Sendable (String, TimeInterval) -> any PayloadCaching<DayReportHistoryResponse> = {
            DiskCache<DayReportHistoryResponse>(key: $0, ttl: $1)
        },
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.client = client
        self.makeCache = makeCache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
    }

    /// Page one: cache first, then the network. Replaces the whole list, so a
    /// report written since the last visit lands at the top and a "Show more"
    /// walk restarts from the newest page.
    func load() async {
        isLoading = true
        stale.connectivityChanged(to: isConnected())
        defer { isLoading = false }

        let cache = makeCache(Self.cacheKey, CacheTTL.dailySeries)
        if let cached = cache.read() {
            apply(cached.value)
            stale.restored(from: cached.capturedAt)
        }
        guard let token = tokenProvider() else { return recordFailure() }
        do {
            let response = try await client.history(cursor: nil, token: token)
            apply(response)
            let now = Date()
            stale.succeeded(at: now)
            cache.write(response, at: now)
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[day-report-history] load failed: \(error)")
            #endif
            recordFailure(error)
        }
    }

    /// The next (older) page. No request without a cursor, no second request
    /// while one is in flight; rows already listed by `(day, kind)` are
    /// skipped so a report written between two presses cannot double up.
    /// Only page one is cached — an older page is re-fetched on demand.
    func loadMore() async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        guard let token = tokenProvider() else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let response = try await client.history(cursor: cursor, token: token)
            let known = Set(items.map(\.rowID))
            items.append(contentsOf: response.items.filter { !known.contains($0.rowID) })
            nextCursor = response.nextCursor
            stale.succeeded(at: Date())
        } catch {
            #if DEBUG
                print("[day-report-history] load more failed: \(error)")
            #endif
            stale.connectivityChanged(to: isConnected())
            stale.failed()
        }
    }

    func refresh() async { await load() }

    func dismissError() { errorMessage = nil }

    func purge() {
        items = []
        nextCursor = nil
        errorMessage = nil
        stale.reset()
    }

    private func apply(_ response: DayReportHistoryResponse) {
        items = response.items
        nextCursor = response.nextCursor
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        if items.isEmpty {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: Self.genericError
            )
        }
    }
}

extension DayReportHistoryItem {
    /// `(day, kind)` — the same identity the server's primary key and its
    /// keyset cursor use, so a `ForEach` and the dedupe agree with the DB.
    var rowID: String { "\(day)-\(kind.rawValue)" }
}

extension DayReportHistoryStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> DayReportHistoryStore {
        DayReportHistoryStore(
            client: DayReportClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}
