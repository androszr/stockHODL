import Foundation
import Observation

/// The add/edit form.
///
/// Three things happen here that the list screen has no business knowing
/// about: the symbol combobox, the FX autofill, and the save. Each has a
/// failure mode of its own, and none of them may take the others down —
/// a symbol search that times out must still leave a form the user can fill
/// in by hand, which is the entire reason `degraded` exists on the wire.
@MainActor
@Observable
final class TransactionFormStore {
    /// What the form is editing. An existing id means PATCH and a locked
    /// instrument; nil means POST.
    let editing: String?

    var draft: TransactionDraft {
        didSet {
            if draft.symbol != oldValue.symbol || draft.currency != oldValue.currency {
                // A different instrument invalidates a rate fetched for the
                // old one. Clearing beats leaving a stale number that looks
                // deliberate.
                if draft.currency != oldValue.currency { fxNote = nil }
            }
            if shouldRefetchFx(from: oldValue) { scheduleFxLookup() }
        }
    }

    private(set) var portfolios: [Portfolio] = []

    /// Field → message, from the local port of `validation.ts`. Shown only for
    /// fields the user has already left, so a form does not open covered in
    /// red before a single character is typed.
    private(set) var issues: [TransactionDraft.Field: String] = [:]
    private(set) var touched: Set<TransactionDraft.Field> = []

    // Symbol search
    private(set) var matches: [SymbolMatch] = []
    private(set) var isSearching = false
    /// The vendor failed AND the local directory had nothing. Means "type it
    /// in yourself", and is deliberately not shown for an ordinary empty
    /// result — "no such ticker" and "search is broken" are different answers.
    private(set) var searchDegraded = false

    // FX
    private(set) var isFetchingFx = false
    /// What happened to the rate lookup, in the user's words. Nil when the
    /// field is untouched by automation.
    private(set) var fxNote: String?

    private(set) var isSaving = false
    private(set) var errorMessage: String?
    /// Set when the save lands. The sheet watches this rather than the store
    /// dismissing itself, because a store that dismisses views cannot be
    /// tested without one.
    private(set) var didSave = false

    static let genericError = "Could not save this transaction."

    private let client: TransactionsClient
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio — see `LiveStore` for why it is injected.
    private let isConnected: @MainActor () -> Bool
    private var searchTask: Task<Void, Never>?
    /// How long the combobox waits before spending a provider call. Injected
    /// so a test can drive the debounce instead of sleeping through it — a
    /// test that waits out a real 250 ms is slow AND flaky, because it passes
    /// or fails on how loaded the machine is.
    private let searchDebounce: Duration
    private var fxTask: Task<Void, Never>?

    init(
        client: TransactionsClient,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        editing: String? = nil,
        draft: TransactionDraft = TransactionDraft(),
        searchDebounce: Duration = .milliseconds(250)
    ) {
        self.client = client
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
        self.editing = editing
        self.draft = draft
        self.searchDebounce = searchDebounce
    }

    /// An edit form, seeded from the stored row.
    ///
    /// The amounts come back as RAW decimal strings on purpose — the contract
    /// says so — because a grouped "1 234,50 zł" would have to be parsed back
    /// before it could be edited, and parsing money back is how a rounding
    /// difference gets introduced.
    static func editing(
        _ row: TransactionRow,
        client: TransactionsClient,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        searchDebounce: Duration = .milliseconds(250)
    ) -> TransactionFormStore {
        var draft = TransactionDraft()
        draft.portfolioId = row.portfolioId
        draft.side = row.side
        draft.symbol = row.symbol
        draft.displayName = row.displayName
        draft.exchange = row.exchange
        draft.currency = row.currency
        draft.quantity = row.quantity
        draft.price = row.price
        draft.fees = row.fees
        draft.tradeDate = row.tradeDate
        draft.fxRateToBase = row.fxRateToBase
        draft.note = row.note ?? ""

        // Seeded through the initialiser, which does NOT run `draft`'s
        // `didSet` — and that matters: an autofill triggered here would
        // overwrite the stored rate of a historical trade with today's idea of
        // what it should have been. The submitted rate is the frozen truth,
        // exactly as it is on the server.
        return TransactionFormStore(
            client: client,
            tokenProvider: tokenProvider,
            isConnected: isConnected,
            editing: row.id,
            draft: draft,
            searchDebounce: searchDebounce
        )
    }

    // MARK: - Setup

    func load() async {
        guard let token = tokenProvider() else { return }
        portfolios = (try? await client.portfolios(token: token)) ?? []

        // A form with one portfolio should not ask which one.
        if draft.portfolioId.isEmpty, portfolios.count == 1 {
            draft.portfolioId = portfolios[0].id
        }
        if draft.tradeDate.isEmpty { draft.tradeDate = TransactionFormStore.today() }
    }

    /// Today in the user's own calendar. A trade date is a calendar fact, not
    /// an instant — which is why it stays a string everywhere else.
    static func today(now: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        return String(
            format: "%04d-%02d-%02d",
            parts.year ?? 2000, parts.month ?? 1, parts.day ?? 1
        )
    }

    // MARK: - Validation

    /// Called when a field loses focus. Validating on every keystroke would
    /// call "1" an invalid price while it is on its way to "182,40".
    func markTouched(_ field: TransactionDraft.Field) {
        touched.insert(field)
        issues = draft.issues()
    }

    func issue(for field: TransactionDraft.Field) -> String? {
        touched.contains(field) ? issues[field] : nil
    }

    var canSave: Bool { draft.issues().isEmpty && !isSaving }

    // MARK: - Symbol search

    /// Debounced. Every keystroke is a paid provider call otherwise, and the
    /// combobox is the one field a user types into character by character.
    func search(_ query: String) {
        searchTask?.cancel()
        let trimmed = query.trimmed()

        guard trimmed.count >= 1 else {
            matches = []
            searchDegraded = false
            isSearching = false
            return
        }

        isSearching = true
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: self?.searchDebounce ?? .zero)
            guard !Task.isCancelled, let self, let token = tokenProvider() else { return }

            let response = try? await client.searchSymbols(trimmed, token: token)
            guard !Task.isCancelled else { return }

            matches = response?.results ?? []
            searchDegraded = response?.degraded == true || response == nil
            isSearching = false
        }
    }

    /// Waits for the in-flight search to finish.
    ///
    /// Exists for the tests, and says so rather than pretending otherwise: the
    /// alternative was a `Task.sleep` long enough to cover the debounce plus
    /// however loaded the machine happens to be, which passes on a quiet
    /// laptop and fails in CI for reasons that have nothing to do with the
    /// code. Awaiting the task itself is the only version that cannot flake.
    func awaitSearch() async {
        await searchTask?.value
    }

    /// Picking a result fills the three instrument fields at once. It is one
    /// choice, not three, and letting them drift apart is how a ticker ends up
    /// bound to the wrong exchange — permanently, since `instruments` is
    /// global and first-write-wins.
    func choose(_ match: SymbolMatch) {
        var next = draft
        next.symbol = match.symbol
        next.displayName = match.name
        next.exchange = match.exchangeDisplay
        // Only when the server was confident. An unmapped exchange leaves the
        // currency where the user put it rather than guessing USD.
        if let currency = match.currency { next.currency = currency }
        draft = next

        matches = []
        searchDegraded = false
    }

    /// Seed the instrument from a screen that already knows it — the phone's
    /// `?symbol=` deep link, opened from a stock's own page.
    ///
    /// It assigns through `draft` rather than through the initialiser, so the
    /// `didSet` fires and the FX lookup runs exactly as it would after picking
    /// the same instrument out of the combobox. Seeding past `didSet` would
    /// leave a USD trade with an empty rate the user had to notice for
    /// themselves.
    func prefill(symbol: String, displayName: String, exchange: String, currency: Currency) {
        var next = draft
        next.symbol = symbol
        next.displayName = displayName
        next.exchange = exchange
        next.currency = currency
        draft = next

        matches = []
        searchDegraded = false
    }

    // MARK: - Screenshot import

    /// The notes the last import disclosed, or empty. Held on the STORE
    /// rather than the view so they survive a re-render and so a test can
    /// read them: every one of them exists because the app inferred something
    /// it might have got wrong, and losing one silently is the failure this
    /// feature is most likely to have.
    private(set) var importNotes: [PrefillNote] = []
    /// Fields that were read off the picture, for the honesty list.
    private(set) var importedFields: [String] = []

    /// Fill the form from a read screenshot.
    ///
    /// It fills VALUES and never picks an instrument: the ticker or company
    /// name is typed into the search box and choosing the company stays an
    /// explicit tap. Resolving a broker's truncated `META PLATFOR` to an
    /// instrument is exactly the guess this app refuses to make on the user's
    /// behalf, because getting it wrong binds a symbol permanently.
    ///
    /// Every decision behind these values — which side the screen meant,
    /// which currency the price is really in, whether a złoty commission
    /// could be converted — was made server-side by `buildTransactionPrefill`,
    /// shared with the web. Nothing is re-derived here.
    func applyPrefill(_ prefill: TransactionImportResponse) {
        var next = draft
        let form = prefill.formPrefill

        if let quantity = form.quantity { next.quantity = quantity }
        if let price = form.price { next.price = price }
        if let fees = form.fees { next.fees = fees }
        if let tradeDate = form.tradeDate { next.tradeDate = tradeDate }
        // The generated `side` IS `TransactionSide` — quicktype collapsed the
        // two identical enums, so there is no mapping to get wrong.
        if let side = form.side { next.side = side }
        draft = next

        importNotes = prefill.notes
        importedFields = prefill.readFields

        // Nothing is marked touched: the user has not left these fields, and
        // reddening a form the moment a picture lands would blame them for
        // the reader's gaps.
        if let query = form.symbolQuery {
            search(query)
        }
    }

    // MARK: - FX

    /// The rate is refetched when the instrument's currency or the trade date
    /// changes, and never when only an amount does.
    private func shouldRefetchFx(from old: TransactionDraft) -> Bool {
        guard draft.needsFxRate else { return false }
        return draft.currency != old.currency || draft.tradeDate != old.tradeDate
    }

    private func scheduleFxLookup() {
        fxTask?.cancel()
        fxTask = Task { [weak self] in
            await self?.fetchFxRate()
        }
    }

    /// The D-1 NBP mid rate for the trade date. Autofilled, and still
    /// overridable — the server validates whatever ends up in the field like
    /// any typed value, so an override is a first-class answer rather than a
    /// way around a check.
    func fetchFxRate() async {
        guard draft.needsFxRate, let token = tokenProvider() else { return }
        guard dateIssue(draft.tradeDate) == nil else { return }

        isFetchingFx = true
        defer { isFetchingFx = false }

        guard let response = try? await client.fxRate(
            currency: draft.currency,
            tradeDate: draft.tradeDate,
            token: token
        ) else {
            fxNote = "Couldn't reach the rate table — enter the rate yourself."
            return
        }

        if response.ok, let rate = response.rate {
            draft.fxRateToBase = rate
            fxNote = response.rateDate.map { "NBP mid rate from \($0)." }
        } else {
            // The reasons are different problems with different answers, and
            // collapsing them into "failed" would hide the one the user can
            // actually act on.
            fxNote = switch response.reason {
            case .notPublished: "No rate published for that date yet — enter it yourself."
            case .noRate: "NBP has no rate for this currency — enter it yourself."
            case .unavailable: "The rate table is unavailable — enter the rate yourself."
            case .invalid, .none: "Enter the rate to PLN yourself."
            }
        }
    }

    // MARK: - Save

    func save() async {
        touched = Set(TransactionDraft.Field.allCases)
        issues = draft.issues()

        guard let body = draft.request(), let token = tokenProvider() else { return }

        isSaving = true
        errorMessage = nil
        awaitingNetwork = false
        defer { isSaving = false }

        do {
            if let editing {
                try await client.update(id: editing, body, token: token)
            } else {
                _ = try await client.create(body, token: token)
            }
            didSave = true
        } catch let APIError.http(_, message) {
            // The server's own words. A 400 names the offending field the same
            // way the web form would, and a 409 explains a conflict this
            // client could not have predicted — a symbol already bound to
            // another currency, or a portfolio that is not the user's.
            errorMessage = message ?? TransactionFormStore.genericError
        } catch {
            #if DEBUG
                print("[transactions] save failed: \(error)")
            #endif
            if let offline = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: TransactionFormStore.genericError
            ) {
                // The sheet does not dismiss — `didSave` is still false — so
                // the draft the user typed is still in front of them, which is
                // the whole point: a form that closed here would have thrown
                // away a transaction the app never even tried to send.
                errorMessage = offline
                awaitingNetwork = true
            } else {
                errorMessage = TransactionFormStore.genericError
            }
        }
    }

    // MARK: - Offline

    /// True after a save that never left the device. Drives the button's
    /// label, and arms the ONE retry below.
    private(set) var awaitingNetwork = false

    /// The network came back with an unsent draft on screen: send it, once.
    ///
    /// Deliberately not a queue. A queue of money writes needs an
    /// idempotency key on the server or a retry can double a purchase, and
    /// `/api/mobile/v1/transactions` has none — so the retry is bounded to the
    /// case where the user is still looking at the form and can see what
    /// happened. `awaitingNetwork` is cleared FIRST so a flapping connection
    /// cannot arm a second attempt behind the first.
    func connectivityChanged(to connected: Bool) {
        guard connected, awaitingNetwork, !isSaving else { return }
        awaitingNetwork = false
        Task { await save() }
    }
}
