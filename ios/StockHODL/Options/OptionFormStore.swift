import Foundation
import Observation

/// The add/edit form for an option lot.
///
/// TWO modes over one store, because they share the lot fields and nothing
/// else:
///
///   - `.add` runs the CASCADE — underlying → expirations → call/put →
///     strikes — and ends with a vendor `OptionContractRef`. Contract identity
///     is never typed: a strike or an expiry the user invented would name a
///     contract that does not exist, and the vendor would price it as nothing
///     forever.
///   - `.edit` is LOT FIELDS ONLY. Contract identity is not editable, by
///     schema (`optionPositionEditSchema` is strict) and not by omission —
///     changing the contract is really a different position, handled by
///     remove + re-add.
///
/// The cascade's failures DEGRADE rather than fail: a vendor hiccup mid-add
/// must leave the form usable and say what it could not fetch, never take the
/// screen down. That is the `degraded` flag on the wire, and the reason the
/// two lookup endpoints answer 200 with `ok: false`.
@MainActor
@Observable
final class OptionFormStore: Identifiable {
    /// Not `Equatable`: the generated contract types are `Codable, Sendable`
    /// and nothing more, and hand-writing conformances for them would be a
    /// second place the wire shape is described.
    enum Mode {
        case add
        case edit(OptionLotItem)
    }

    nonisolated let id = UUID()
    let mode: Mode

    /// Which lot is being edited, or nil in add mode. The id is what the
    /// PATCH addresses — never a card key.
    var editingLotID: String? {
        if case let .edit(lot) = mode { return lot.id }
        return nil
    }

    // MARK: - The cascade (add mode)

    var underlying = "" {
        didSet {
            guard underlying != oldValue else { return }
            // A different underlying invalidates everything downstream.
            // Clearing beats leaving a strike that belonged to another stock.
            expirations = []
            strikes = []
            selectedExpiration = nil
            selectedTicker = nil
            scheduleExpirationsLookup()
        }
    }

    private(set) var expirations: [OptionExpiry] = []
    private(set) var strikes: [OptionContractRef] = []

    var selectedExpiration: String? {
        didSet {
            guard selectedExpiration != oldValue else { return }
            strikes = []
            selectedTicker = nil
            strikesTask = Task { await loadStrikes() }
        }
    }

    var contractType = "call" {
        didSet {
            guard contractType != oldValue else { return }
            strikes = []
            selectedTicker = nil
            strikesTask = Task { await loadStrikes() }
        }
    }

    /// The chosen contract, held as its OCC TICKER rather than as the struct:
    /// the generated types carry no `Hashable`, and a `Picker` needs one. The
    /// ticker is the identity anyway — it is what the server stores.
    var selectedTicker: String?

    var selectedContract: OptionContractRef? {
        strikes.first { $0.ticker == selectedTicker }
    }

    private(set) var isLoadingExpirations = false
    private(set) var isLoadingStrikes = false
    /// The vendor failed. Means "try again in a moment", and is deliberately
    /// distinct from an empty result — "no contracts there" and "the lookup is
    /// broken" are different answers.
    private(set) var chainDegraded = false

    // MARK: - Screenshot import

    /// What the last read could NOT settle, as sentences. Held on the store so
    /// the form can show them beside the cascade the user now has to finish
    /// by hand.
    private(set) var importNotes: [String] = []

    /// A screenshot named a contract the vendor's chain has no EXACT match
    /// for, but the same server-side check found close real ones — the
    /// `nearby` outcome of `POST /api/mobile/v1/import/option/match`, the
    /// same near-miss list the web wizard offers. Empty except right after
    /// an import that landed here; tapping one calls `adopt(_:)`.
    private(set) var matchAlternatives: [OptionContractRef] = []

    /// Drive the cascade from a read screenshot.
    ///
    /// It DRIVES rather than fills: setting `underlying` fetches the real
    /// expirations from the vendor, and only an expiry and a strike the vendor
    /// actually lists can be chosen. A screenshot cannot conjure a contract
    /// that does not exist — the picture proposes, the chain disposes. That is
    /// why this is a cascade and not six text fields, and why a misread strike
    /// ends as an unselected picker rather than as a saved lot nobody holds.
    ///
    /// The lot figures (quantity, premium, date, fees) are plain fields and
    /// are filled directly; they are the user's own record of what they paid,
    /// not something the vendor can confirm.
    func applyExtraction(_ response: OptionImportResponse) async {
        let extraction = response.extraction
        var unresolved: [String] = []

        if let quantity = extraction.quantity { self.quantity = quantity }
        if let entryPrice = extraction.entryPrice { self.entryPrice = entryPrice }
        if let tradeDate = extraction.tradeDate { self.tradeDate = tradeDate }
        if let fees = extraction.fees { self.fees = fees }

        if let type = extraction.contractType {
            contractType = type.rawValue
        }

        guard let ticker = extraction.underlyingTickerCandidate else {
            // A company name without a ticker is not enough to open a chain:
            // the option endpoints take a symbol, and guessing one from
            // "Example Corp." is the kind of guess that binds the wrong
            // contract.
            if let name = extraction.companyName {
                unresolved.append("The screenshot shows \(name) but no ticker — pick the underlying yourself.")
            } else {
                unresolved.append("No underlying could be read — pick one to load the chain.")
            }
            importNotes = unresolved
            return
        }

        underlying = ticker
        // The cascade is debounced and asynchronous by design; the import has
        // to wait for the real chain before it can claim a date exists on it.
        await awaitChain()

        if let type = extraction.contractType,
           let strike = extraction.strikePrice,
           let expiry = extraction.expirationDate,
           let token = tokenProvider()
        {
            // THE VERIFICATION GATE — the same server-side check the web
            // wizard makes, not a local string-match against whatever this
            // device already happened to fetch. An expiry or strike read a
            // shade off what the vendor lists comes back `nearby` with the
            // closest REAL contracts, instead of a dead end that forces the
            // whole cascade to be redone by hand.
            do {
                let response = try await client.match(
                    OptionMatchRequest(
                        companyName: nil,
                        contractType: type,
                        expirationDate: expiry,
                        strikePrice: strike,
                        underlying: ticker
                    ),
                    token: token
                )
                #if DEBUG
                    print("[options-chain] match(\(ticker) \(strike) \(expiry)) status=\(response.status.rawValue)")
                #endif
                switch response.status {
                case .matched:
                    if let contract = response.contract {
                        await adopt(contract)
                    }
                case .nearby:
                    matchAlternatives = response.alternatives ?? []
                    unresolved.append("No exact match for that contract — pick one of the closest real ones below.")
                case .unresolved:
                    unresolved.append("Couldn't find that contract on the chain — pick the expiry and strike yourself.")
                case .degraded:
                    #if DEBUG
                        print("[options-chain] match degraded, reason=\(response.reason?.rawValue ?? "nil")")
                    #endif
                    chainDegraded = true
                }
            } catch {
                #if DEBUG
                    print("[options-chain] match(\(ticker) \(strike) \(expiry)) failed: \(error)")
                #endif
                chainDegraded = true
            }
        } else if let expiry = extraction.expirationDate {
            // Not enough on the screenshot for a full match (e.g. no strike
            // read) — fall back to placing the cascade on the expiry alone.
            if expirations.contains(where: { $0.expirationDate == expiry }) {
                selectedExpiration = expiry
                await awaitChain()
            } else {
                unresolved.append("\(ticker) has no \(expiry) expiry listed — pick the right one.")
            }
        }

        importNotes = unresolved
        validate()
    }

    /// Adopt a server-verified contract — from an exact import match, or from
    /// tapping one of `matchAlternatives`. Drives the same cascade fields a
    /// manual pick would, so picker state stays consistent either way.
    func adopt(_ contract: OptionContractRef) async {
        matchAlternatives = []
        underlying = contract.underlying
        contractType = contract.contractType.rawValue
        // `underlying`'s didSet only re-fetches when it actually changed;
        // awaiting here is a no-op when it didn't and the real wait when it did.
        await awaitChain()
        selectedExpiration = contract.expirationDate
        await awaitChain()
        selectedTicker = contract.ticker
    }

    /// Waits for whichever chain lookup the last assignment started.
    private func awaitChain() async {
        await lookupTask?.value
        await strikesTask?.value
    }

    /// Waits until every chain lookup already started has landed — the
    /// debounced expirations fetch and the strikes fetch. The tests' seam:
    /// awaiting the real task instead of polling for its effect, so a loaded
    /// machine makes a test slower, never red.
    func settleChain() async {
        await awaitChain()
    }

    // MARK: - The lot fields (both modes)

    var quantity = ""
    var entryPrice = ""
    var tradeDate = ""
    var fees = ""

    private(set) var issues: [Field: String] = [:]
    private(set) var touched: Set<Field> = []

    enum Field: Hashable, CaseIterable {
        case contract
        case quantity
        case entryPrice
        case tradeDate
        case fees
    }

    private(set) var isSaving = false
    private(set) var errorMessage: String?
    /// Set when the save lands. The sheet watches this rather than the store
    /// dismissing itself, because a store that dismisses views cannot be
    /// tested without one.
    private(set) var didSave = false

    private let client: OptionsClient
    private let tokenProvider: @MainActor () -> String?
    private var lookupTask: Task<Void, Never>?
    /// How long typing must pause before the expirations lookup fires.
    /// Injected ONLY so a test need not wait out the real pause; production
    /// always gets `OptionFormStore.lookupDebounce`.
    private let lookupDebounce: Duration
    /// How the pause is waited out. Production always sleeps; a test injects
    /// a pause it ends itself, so "the next keystroke landed inside the pause"
    /// is a fact of the test and never a race against a loaded machine.
    private let debouncePause: DebouncePause
    /// Held rather than fire-and-forget so the screenshot import can wait for
    /// the real chain before deciding a strike is missing from it.
    private var strikesTask: Task<Void, Never>?

    init(
        mode: Mode,
        client: OptionsClient,
        tokenProvider: @escaping @MainActor () -> String?,
        lookupDebounce: Duration = OptionFormStore.lookupDebounce,
        debouncePause: @escaping DebouncePause = OptionFormStore.sleepPause
    ) {
        self.mode = mode
        self.client = client
        self.tokenProvider = tokenProvider
        self.lookupDebounce = lookupDebounce
        self.debouncePause = debouncePause

        if case let .edit(lot) = mode {
            // The RAW strings, never the formatted twins: prefilling from
            // "5,20 USD" would either fail validation or, worse, parse to 5.
            quantity = lot.quantityRaw
            entryPrice = lot.entryPriceRaw
            tradeDate = lot.tradeDate
            fees = lot.feesRaw
        } else {
            tradeDate = OptionFormStore.todayISO()
        }
    }

    // MARK: - Validation

    /// The same bounds `optionPositionAddSchema` applies, through the same
    /// local port of `validation.ts` the transaction form uses. A rule that
    /// reads differently in two places is a rule the user has to learn twice.
    func validate() {
        var found: [Field: String] = [:]

        if case .add = mode, selectedContract == nil {
            found[.contract] = "Pick a contract"
        }
        if let issue = decimalIssue(normalizeDecimalSeparator(quantity), .amount) {
            found[.quantity] = issue
        }
        if let issue = decimalIssue(normalizeDecimalSeparator(entryPrice), .amount) {
            found[.entryPrice] = issue
        }
        if let issue = dateIssue(tradeDate) {
            found[.tradeDate] = issue
        }
        // Empty fees means zero — the transaction-fees pattern, and the
        // server's own `preprocess`.
        let feeText = normalizeDecimalSeparator(fees)
        if !feeText.isEmpty, let issue = decimalIssue(feeText, .fee) {
            found[.fees] = issue
        }

        issues = found
    }

    var isValid: Bool {
        validate()
        return issues.isEmpty
    }

    func markTouched(_ field: Field) {
        touched.insert(field)
        validate()
    }

    /// Shown only for fields the user has already left, so a form does not
    /// open covered in red before a character is typed.
    func visibleIssue(_ field: Field) -> String? {
        touched.contains(field) ? issues[field] : nil
    }

    // MARK: - The cascade's fetches

    private func scheduleExpirationsLookup() {
        lookupTask?.cancel()
        let symbol = underlying.trimmed().uppercased()
        guard symbol.count >= 1 else {
            isLoadingExpirations = false
            return
        }

        let debounce = lookupDebounce
        let pause = debouncePause
        lookupTask = Task { [weak self] in
            // Debounced: the vendor is asked once the typing stops, not once
            // per keystroke. Each lookup is a paid upstream call. A zero pause
            // (tests only) skips the sleep outright: `Task.sleep(for: .zero)`
            // still parks on a timer, which would make "no debounce" as
            // timing-dependent as the debounce it is compared against.
            if debounce > .zero {
                try? await pause(debounce)
            }
            guard !Task.isCancelled else { return }
            await self?.loadExpirations(symbol)
        }
    }

    private func loadExpirations(_ symbol: String) async {
        guard let token = tokenProvider() else { return }
        isLoadingExpirations = true
        defer { isLoadingExpirations = false }

        let response: OptionExpirationsResponse
        do {
            response = try await client.expirations(underlying: symbol, token: token)
        } catch {
            #if DEBUG
                print("[options-chain] expirations(\(symbol)) failed: \(error)")
            #endif
            chainDegraded = true
            return
        }
        guard !Task.isCancelled else { return }

        #if DEBUG
            if !response.ok {
                print("[options-chain] expirations(\(symbol)) degraded, reason=\(response.reason?.rawValue ?? "nil")")
            }
        #endif
        chainDegraded = !response.ok
        expirations = response.expirations ?? []
    }

    private func loadStrikes() async {
        guard let token = tokenProvider(),
              let expiration = selectedExpiration
        else { return }

        let symbol = underlying.trimmed().uppercased()
        isLoadingStrikes = true
        defer { isLoadingStrikes = false }

        let response: OptionStrikesResponse
        do {
            response = try await client.strikes(
                underlying: symbol,
                expirationDate: expiration,
                contractType: contractType,
                token: token
            )
        } catch {
            #if DEBUG
                print("[options-chain] strikes(\(symbol), \(expiration), \(contractType)) failed: \(error)")
            #endif
            chainDegraded = true
            return
        }

        #if DEBUG
            if !response.ok {
                print(
                    "[options-chain] strikes(\(symbol), \(expiration)) degraded, "
                        + "reason=\(response.reason?.rawValue ?? "nil")"
                )
            }
        #endif
        chainDegraded = !response.ok
        strikes = response.contracts ?? []
    }

    // MARK: - Save

    func save(into store: OptionsStore) async {
        touched = Set(Field.allCases)
        guard isValid, !isSaving else { return }

        isSaving = true
        defer { isSaving = false }

        let ok: Bool
        switch mode {
        case .add:
            guard let contract = selectedContract else { return }
            ok = await store.add(
                OptionAddRequest(
                    contract: contract,
                    quantity: normalizeDecimalSeparator(quantity),
                    entryPrice: normalizeDecimalSeparator(entryPrice),
                    tradeDate: tradeDate,
                    fees: normalizedFees
                )
            )
        case let .edit(lot):
            ok = await store.update(
                OptionEditRequest(
                    id: lot.id,
                    quantity: normalizeDecimalSeparator(quantity),
                    entryPrice: normalizeDecimalSeparator(entryPrice),
                    tradeDate: tradeDate,
                    fees: normalizedFees
                )
            )
        }

        if ok { didSave = true }
    }

    /// Empty means zero, matching the server's `preprocess`. Sending "" would
    /// be a 400 the web form never provokes.
    private var normalizedFees: String {
        let text = normalizeDecimalSeparator(fees)
        return text.isEmpty ? "0" : text
    }

    /// 350 ms: long enough that a typed ticker is one lookup, short enough
    /// that the picker fills before the user reaches for it.
    static let lookupDebounce: Duration = .milliseconds(350)

    /// Waits out a debounce; throws (or returns early) when the waiting task
    /// is cancelled, like `Task.sleep`.
    typealias DebouncePause = @MainActor @Sendable (Duration) async throws -> Void

    /// The production pause: a real sleep.
    static let sleepPause: DebouncePause = { duration in
        try await Task.sleep(for: duration)
    }

    private static func todayISO() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
}
