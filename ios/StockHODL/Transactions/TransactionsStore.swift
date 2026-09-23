import Foundation
import Observation

/// The transaction list.
///
/// Read-only state plus one destructive action. It holds no draft — the form
/// owns that — so the list survives a sheet being opened, cancelled and
/// reopened without carrying anything over.
///
/// Cached on disk, with a longer TTL than anything holding quotes: these are
/// rows the USER typed, and a purchase made in March is still a purchase in
/// August. It is capped anyway — a fortnight — because a journal that has not
/// been confirmed in two weeks is likelier to be missing rows than to be
/// right, and a journal missing rows is the one that makes a user think they
/// forgot to record something.
@MainActor
@Observable
final class TransactionsStore {
    private(set) var rows: [TransactionRow] = []
    private(set) var isLoading = true
    private(set) var errorMessage: String?
    /// A row the server says is already gone. Shown once, then cleared —
    /// unlike the web action, the phone acts on the verdict, because a client
    /// working from its own snapshot should learn its list is stale rather
    /// than believe it just deleted something.
    private(set) var staleNotice: String?

    /// Freshness, shared with every other store — see `StaleState`.
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    static let genericError = "Could not load your transactions."

    private let client: TransactionsClient
    private let cache: any PayloadCaching<[TransactionRow]>
    private let tokenProvider: @MainActor () -> String?
    private let isConnected: @MainActor () -> Bool

    init(
        client: TransactionsClient,
        cache: any PayloadCaching<[TransactionRow]> = DiskCache<[TransactionRow]>(
            key: "transactions",
            ttl: CacheTTL.ledger
        ),
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.client = client
        self.cache = cache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
    }

    /// The Holdings chart's entry point, and the only caller that is not a
    /// screen about the journal itself.
    ///
    /// `.task` re-runs on every reselection of the Holdings tab and `load()`
    /// always issues the request, so the trade markers would cost one round
    /// trip per tab tap. These are rows the USER typed: anything captured
    /// inside `CacheTTL.ledger` — this session's fetch, or the disk copy
    /// `load()` would have painted from anyway — already answers the question.
    /// The Transactions screen keeps calling `load()`, because a screen ABOUT
    /// the journal should confirm it.
    func loadIfNeeded() async {
        // Disk first, exactly as `load()` does, so a cold launch onto Holdings
        // has its marks without waiting for a request it may not even make.
        if rows.isEmpty, let cached = cache.read() {
            rows = cached.value
            stale.restored(from: cached.capturedAt)
        }

        if !rows.isEmpty, let capturedAt = stale.capturedAt {
            let age = Date().timeIntervalSince(capturedAt)
            // A NEGATIVE age is a clock that moved backwards, not a payload
            // from the future — expired, the same reading `DiskCache` takes.
            if age >= 0, age <= CacheTTL.ledger {
                isLoading = false
                return
            }
        }

        await load()
    }

    /// Forget how fresh the journal is, so the next `loadIfNeeded()` refetches
    /// instead of trusting the copy in hand.
    ///
    /// The TTL gate above is what stops a tab tap costing a request; it is
    /// also what would hide a trade the user recorded SECONDS ago for the rest
    /// of the fortnight, because a write made anywhere else in the app does
    /// not touch these rows. Every add path calls this and then reloads, so
    /// the marker for a new trade appears on the chart with the trade.
    func invalidate() {
        stale.reset()
    }

    func load() async {
        defer { isLoading = false }
        stale.connectivityChanged(to: isConnected())

        // Disk first, so the screen has rows before the request is even made.
        // Pushing into the journal offline used to give a spinner and then an
        // error, over a list the app had successfully loaded an hour earlier.
        if rows.isEmpty, let cached = cache.read() {
            rows = cached.value
            stale.restored(from: cached.capturedAt)
        }

        // Before the `defer`'s job was done this returned with `isLoading`
        // still true, which is a permanent spinner rather than a failure the
        // screen can say anything about.
        guard let token = tokenProvider() else {
            recordFailure()
            return
        }

        do {
            let fresh = try await client.list(token: token)
            rows = fresh
            let now = Date()
            stale.succeeded(at: now)
            cache.write(fresh, at: now)
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[transactions] list failed: \(error)")
            #endif
            recordFailure(error)
        }
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        // Only when there is nothing on screen. A failed refresh over a
        // painted list is staleness — which the bar says — not an outage.
        if rows.isEmpty {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: TransactionsStore.genericError
            )
        }
    }

    func delete(_ row: TransactionRow) async {
        guard let token = tokenProvider() else { return }

        do {
            try await client.delete(id: row.id, token: token)
            rows.removeAll { $0.id == row.id }
            // The cache has to follow the deletion, or the next cold launch
            // repaints the row the user just removed and the app looks like it
            // ignored them.
            cache.write(rows)
        } catch let APIError.http(status, _) where status == 404 {
            // Already gone — deleted from the web, or from a second tap. Drop
            // it and say so, rather than leaving a row that cannot be removed.
            rows.removeAll { $0.id == row.id }
            cache.write(rows)
            staleNotice = "That transaction was already gone."
        } catch let error as APIError where error.isOffline || !isConnected() {
            // A write that never left the device. Naming that is the whole
            // point: "Could not delete that transaction" reads as a refusal by
            // the server, and a user who believes the server refused will not
            // try again later.
            errorMessage = "You're offline — that transaction wasn't deleted."
        } catch {
            #if DEBUG
                print("[transactions] delete failed: \(error)")
            #endif
            errorMessage = "Could not delete that transaction."
        }
    }

    /// Everything derived from the account, dropped on sign-out — the same
    /// contract every other hoisted store's `purge()` honours. It became one
    /// of those when the journal moved out of `RouteStores` (whose `purge()`
    /// used to do this by releasing the whole store) to feed the Holdings
    /// chart's trade markers.
    func purge() {
        rows = []
        errorMessage = nil
        staleNotice = nil
        isLoading = true
        stale.reset()
    }

    func dismissNotice() {
        staleNotice = nil
        errorMessage = rows.isEmpty ? errorMessage : nil
    }

    /// Rows grouped by trade date, newest first — the order a statement is
    /// read in. The server already sorts; this only inserts the headers.
    var sections: [(date: String, rows: [TransactionRow])] {
        var order: [String] = []
        var grouped: [String: [TransactionRow]] = [:]

        for row in rows {
            if grouped[row.tradeDate] == nil { order.append(row.tradeDate) }
            grouped[row.tradeDate, default: []].append(row)
        }
        return order.map { (date: $0, rows: grouped[$0] ?? []) }
    }
}
