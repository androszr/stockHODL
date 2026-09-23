import Foundation
import Observation

/// The manual dividend form — add and correct.
///
/// The same shape as `TransactionFormStore`: a draft with local validation for
/// UX, a server that re-validates with the identical schema and has the final
/// word, and a `didSave` flag the sheet watches rather than a store that
/// dismisses views (a store that dismissed views could not be tested without
/// one).
///
/// What is NOT here is any arithmetic. Net is derived server-side on `Decimal`
/// and comes back on the row; this form collects gross and withholding and
/// submits them as typed. A form that showed its own running net would be a
/// second opinion about a tax figure.
@MainActor
@Observable
final class DividendFormStore {
    /// The payment being corrected, or nil when adding. An id means PATCH and
    /// a locked instrument and currency.
    let editing: String?
    /// True when the row came from the vendor. Its PORTFOLIO is locked as well
    /// — re-keying one would vacate the `(vendorEventId, portfolioId)` slot for
    /// the next sync to re-fill, and the same dividend would then count twice.
    let isVendorRow: Bool

    var draft: DividendDraft

    private(set) var portfolios: [DividendInstrumentListPortfolio] = []
    private(set) var instruments: [DividendInstrument] = []
    private(set) var isLoadingOptions = false

    /// Shown only for fields the user has already left, so the form does not
    /// open covered in red before a single character is typed.
    private(set) var issues: [DividendDraft.Field: String] = [:]
    private(set) var touched: Set<DividendDraft.Field> = []

    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var didSave = false

    static let genericError = "Could not save this payment."

    private let client: DividendsClient
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio — see `LiveStore` for why it is injected.
    private let isConnected: @MainActor () -> Bool

    init(
        client: DividendsClient,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        editing: String? = nil,
        isVendorRow: Bool = false,
        draft: DividendDraft = DividendDraft()
    ) {
        self.client = client
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
        self.editing = editing
        self.isVendorRow = isVendorRow
        self.draft = draft
    }

    static func editing(
        _ payment: DividendPayment,
        client: DividendsClient,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) -> DividendFormStore {
        DividendFormStore(
            client: client,
            tokenProvider: tokenProvider,
            isConnected: isConnected,
            editing: payment.id,
            isVendorRow: payment.source == .massive,
            draft: DividendDraft.editing(payment)
        )
    }

    // MARK: - Options

    /// The two dropdowns. One request, because the form cannot render without
    /// both and a phone pays the round trip twice if they queue.
    func loadOptions() async {
        guard let token = tokenProvider(), instruments.isEmpty, portfolios.isEmpty else { return }
        isLoadingOptions = true
        defer { isLoadingOptions = false }

        guard let options = try? await client.formOptions(token: token) else {
            errorMessage = "Could not load your instruments."
            return
        }
        instruments = options.instruments
        portfolios = options.portfolios

        // Only one place to file it: pre-select rather than make the user open
        // a picker with a single row in it.
        if draft.portfolioId.isEmpty, portfolios.count == 1 {
            draft.portfolioId = portfolios[0].id
        }
    }

    /// True when there is nothing to attach a payment to. The screen says
    /// "record a transaction first" rather than showing pickers with no rows —
    /// a dividend attaches to a stock the ledger already knows about, and the
    /// manual path can never mint one.
    var hasNothingToAttachTo: Bool {
        !isLoadingOptions && (instruments.isEmpty || portfolios.isEmpty)
    }

    /// Picking an instrument sets the currency with it. It is one choice, not
    /// two: the currency belongs to the instrument, and letting them drift
    /// apart would submit a payment in money the stock does not trade in.
    func choose(instrumentId: String) {
        draft.instrumentId = instrumentId
        if let match = instruments.first(where: { $0.id == instrumentId }),
           let currency = Currency(rawValue: match.currency) {
            draft.currency = currency
        }
    }

    /// The instrument's own label, for the locked row on an edit form.
    var instrumentLabel: String? {
        instruments.first { $0.id == draft.instrumentId }?.symbol
    }

    // MARK: - Validation

    func markTouched(_ field: DividendDraft.Field) {
        touched.insert(field)
        revalidate()
    }

    /// The message for a field the user has already left, or nil.
    func issue(for field: DividendDraft.Field) -> String? {
        touched.contains(field) ? issues[field] : nil
    }

    func revalidate() {
        let all = draft.issues()
        issues = all.filter { touched.contains($0.key) }
    }

    /// Whether Save can be pressed at all — computed over EVERY field, not
    /// just the touched ones, so an untouched required field does not read as
    /// a form that is ready.
    var canSave: Bool {
        !isSaving && draft.issues().isEmpty
    }

    // MARK: - Saving

    func save() async {
        guard let token = tokenProvider() else { return }

        // Everything becomes touched at submit: a refusal the user has not
        // seen yet is exactly what they need to see now.
        touched = Set(DividendDraft.Field.allCases)
        revalidate()
        guard issues.isEmpty else { return }

        isSaving = true
        defer { isSaving = false }

        do {
            if let editing {
                guard let body = draft.updateRequest() else { return }
                try await client.update(id: editing, body, token: token)
            } else {
                guard let body = draft.createRequest() else { return }
                try await client.create(body, token: token)
            }
            errorMessage = nil
            didSave = true
        } catch let APIError.http(_, message) {
            // The server's own sentence. The realistic ones here are the
            // vendor-row portfolio lock and "instrument not found", and both
            // tell the user something they cannot work out from the form.
            errorMessage = message ?? DividendFormStore.genericError
        } catch {
            #if DEBUG
                print("[dividend form] save failed: \(error)")
            #endif
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: DividendFormStore.genericError
            ) ?? DividendFormStore.genericError
        }
    }

    func dismissError() { errorMessage = nil }
}
