import Foundation
import Observation

/// What the ledger has actually been paid.
///
/// A read-only store for a screen opened occasionally, so it is deliberately
/// as dumb as the passkeys one: no poll, no stream. It loads when the screen
/// appears and on pull-to-refresh, and that is the lifecycle.
///
/// It does now keep a disk cache, on the ledger TTL: a dividend recorded in
/// March does not change, and a screen "opened occasionally" is precisely the
/// one most likely to be opened somewhere with no signal. Cached PER FILTER —
/// the whole ledger and one symbol's slice are different answers, and a shared
/// file would let a per-ticker view paint as if it were everything.
///
/// Nothing here folds money. `netPLN`, the per-year totals and the per-row net
/// all arrive already computed, on `Decimal`, from the ONE fold in
/// `src/lib/dividends/summary.ts` that the web page uses too. A store that
/// re-added a column would be a second opinion about what a year was worth,
/// and the two surfaces would eventually disagree in front of the user.
@Observable
@MainActor
final class DividendsStore {
    private(set) var payments: [DividendPayment] = []
    private(set) var years: [DividendYearGroup] = []
    private(set) var summary: DividendSummary?

    private(set) var isLoading = false
    /// True while the VENDOR re-sync is running. Separate from `isLoading`
    /// because they mean different things to the user: one is "fetching what
    /// we have", the other is "asking the vendor again", and the second is the
    /// slow one worth showing a spinner for.
    private(set) var isSyncing = false
    private(set) var errorMessage: String?
    /// True once a load has completed, so an empty list can say "nothing yet"
    /// instead of flashing it before the first answer arrives.
    private(set) var hasLoaded = false

    /// Freshness, shared with every other store — see `StaleState`.
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    static let genericError = "Could not load your dividends."

    private let client: DividendsClient
    /// A cache per filter combination, built on demand. A closure rather than
    /// a stored instance because the key depends on what the screen is asking
    /// for, and a test needs to substitute the whole family at once.
    private let makeCache: @Sendable (String) -> any PayloadCaching<DividendsResponse>
    private let tokenProvider: @MainActor () -> String?
    private let isConnected: @MainActor () -> Bool

    init(
        client: DividendsClient,
        makeCache: @escaping @Sendable (String) -> any PayloadCaching<DividendsResponse> = {
            DiskCache<DividendsResponse>(key: "dividends-\($0)", ttl: CacheTTL.ledger)
        },
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.client = client
        self.makeCache = makeCache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
    }

    /// One key per filter combination. `|` because neither a portfolio id nor
    /// a symbol can contain it, so "all dividends for symbol `A|B`" cannot
    /// collide with "portfolio `A` for symbol `B`".
    private static func cacheKey(portfolioId: String?, symbol: String?) -> String {
        "\(portfolioId ?? "all")|\(symbol ?? "all")"
    }

    /// The filters the last load used, so a write can reload the SAME view
    /// rather than silently widening it to the whole ledger.
    private var lastPortfolioId: String?
    private var lastSymbol: String?

    /// Rows for one year group, resolved through the id list the payload
    /// carries. The server grouped them; this only joins.
    func payments(in group: DividendYearGroup) -> [DividendPayment] {
        let byId = Dictionary(payments.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return group.paymentIds.compactMap { byId[$0] }
    }

    func load(portfolioId: String? = nil, symbol: String? = nil) async {
        lastPortfolioId = portfolioId
        lastSymbol = symbol
        isLoading = true
        stale.connectivityChanged(to: isConnected())
        defer {
            isLoading = false
            hasLoaded = true
        }

        let cache = makeCache(DividendsStore.cacheKey(portfolioId: portfolioId, symbol: symbol))
        // Disk first, so the screen has a ledger before the request is made.
        // Reached from Holdings and from a stock's page — both of which the
        // user may well be looking at on a train.
        if payments.isEmpty, let cached = cache.read() {
            apply(cached.value)
            stale.restored(from: cached.capturedAt)
        }

        // The token check comes AFTER the cache read on purpose: a transient
        // Keychain miss (see `MigratingTokenStore`) used to return here with
        // nothing on screen, and there is no reason a missing token should
        // also cost the user the ledger already sitting on disk.
        guard let token = tokenProvider() else {
            recordFailure()
            return
        }

        do {
            let response = try await client.load(
                portfolioId: portfolioId,
                symbol: symbol,
                token: token
            )
            apply(response)
            let now = Date()
            stale.succeeded(at: now)
            cache.write(response, at: now)
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[dividends] load failed: \(error)")
            #endif
            recordFailure(error)
        }
    }

    private func apply(_ response: DividendsResponse) {
        payments = response.payments
        years = response.years
        summary = response.summary
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        // A list already on screen stays on screen: it was true a moment ago,
        // and blanking it to say "could not load" loses more than it tells.
        // The FIRST load has nothing to keep, so it says so — and says WHICH
        // problem it is.
        if payments.isEmpty {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: DividendsStore.genericError
            )
        }
    }

    // MARK: - Writes

    /// Re-ask the vendor, then reload.
    ///
    /// The sync is best-effort end to end and never fails loudly: a vendor
    /// that did not answer leaves the ledger exactly as it was, which is
    /// indistinguishable from a sync that found nothing new. So this reports
    /// nothing on its own — it reloads, and whatever landed is on screen.
    ///
    /// Edited and manual rows are untouched by it. That rule lives in
    /// `src/lib/dividends/store.ts` and is the reason a correction made here
    /// survives every future refresh.
    func refreshFromVendor() async {
        guard let token = tokenProvider() else { return }
        isSyncing = true
        defer { isSyncing = false }

        var failed = false
        do {
            try await client.refresh(token: token)
        } catch {
            #if DEBUG
                print("[dividends] vendor refresh failed: \(error)")
            #endif
            failed = true
        }

        await reload()
        // AFTER the reload, deliberately. A successful reload clears
        // `errorMessage` — as it should, since the list on screen is now
        // correct — and setting the message first would have it wiped by the
        // very reload that proves the payments are unchanged.
        if failed {
            errorMessage = "Could not reach the dividend feed. Your payments are unchanged."
        }
    }

    /// Remove one payment, then reload.
    ///
    /// A vendor-sourced row is TOMBSTONED rather than erased — the ledger
    /// still derives shares held on that ex-date, so a hard delete would be
    /// silently re-inserted by the next sync. The client does not need to know
    /// which happened: either way the row is gone, and the reload proves it.
    func delete(_ payment: DividendPayment) async {
        guard let token = tokenProvider() else { return }

        do {
            try await client.delete(id: payment.id, token: token)
        } catch let APIError.http(status, _) where status == 404 {
            // Already gone — deleted on the web, or a second tap. Fall through
            // to the reload rather than complain about a row that is not there.
        } catch {
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: "Could not delete that payment."
            ) ?? "Could not delete that payment."
            return
        }
        await reload()
    }

    /// Reload with whatever filters the screen is currently showing. A write
    /// must not widen a per-ticker view into the whole ledger.
    func reload() async {
        await load(portfolioId: lastPortfolioId, symbol: lastSymbol)
    }

    func dismissError() {
        errorMessage = nil
    }

    func purge() {
        payments = []
        years = []
        summary = nil
        errorMessage = nil
        hasLoaded = false
        stale.reset()
    }
}

extension DividendPayment {
    /// The only date this row honestly carries: the pay date when it has one,
    /// the ex-date otherwise. Mirrors `paymentDate()` in
    /// `src/lib/dividends/summary.ts`, which is what the server grouped by —
    /// so a row cannot appear under a year the header does not show.
    var effectiveDate: String { payDate ?? exDate }

    /// True when the row is dated by its EX-date because no payment date
    /// exists yet — announced, not paid. The screen marks it rather than
    /// letting an announcement read as money received.
    var isAnnouncedOnly: Bool { payDate == nil }

    /// Why this row is missing from the PLN totals, or nil when it is in them.
    ///
    /// Two states, never one: a currency on the NBP allowlist is genuinely
    /// awaiting a rate the next sync can fetch, while one outside it will
    /// never have a rate at all. Collapsing them would turn a permanent gap
    /// into one that looks like it is arriving.
    var fxGap: FxGap? {
        guard fxRateToBase == nil else { return nil }
        // `Currency` is GENERATED from the same `CURRENCIES` allowlist that
        // `isFxSupported` serves, so this cannot drift from the server's
        // decision — adding a currency there regenerates it here. The COUNTS
        // on screen still come from the server; this only labels one row.
        return Currency(rawValue: currency) != nil ? .awaiting : .unsupported
    }

    enum FxGap: Sendable {
        case awaiting
        case unsupported
    }
}
