import Foundation

/// The dividend form's editable state and its local port of
/// `src/lib/dividends/validation.ts`.
///
/// Local validation is UX, never authority: the server re-parses every field
/// with the same rules and its answer is the one that counts. What this buys
/// is a refusal shown beside the field the moment the user leaves it, instead
/// of after a round trip — the exact arrangement `TransactionDraft` already
/// has, and it reuses that file's `decimalIssue`, `DecimalBounds`,
/// `normalizeDecimalSeparator` and `dateIssue` rather than restating them.
///
/// Nothing here does arithmetic on money. The one comparison —
/// withheld ≤ gross — is made on `Decimal` through `dec()`, and its result is
/// a message rather than a number.
struct DividendDraft: Sendable, Equatable {
    var portfolioId = ""
    var instrumentId = ""
    /// Set alongside `instrumentId` and never editable on its own: the
    /// currency belongs to the instrument, and the server refuses to rebind
    /// either on an edit.
    var currency: Currency = .usd

    var exDate = ""
    /// Empty means announced but not paid. Sent as ABSENT, never as "".
    var payDate = ""
    var quantity = ""
    var amountPerShare = ""
    var grossAmount = ""
    /// Blank is zero — the schema's own preprocess. A dividend with no
    /// withholding is the ordinary case and must not require typing "0".
    var withheldTax = ""
    /// Empty means "not published yet" — stored as NULL and shown as an
    /// honest dash, never as a fabricated 1.
    var fxRateToBase = ""
    var note = ""

    enum Field: String, Sendable, CaseIterable {
        case portfolioId
        case instrumentId
        case exDate
        case payDate
        case quantity
        case amountPerShare
        case grossAmount
        case withheldTax
        case fxRateToBase
    }

    /// Every refusal the form can state on its own, keyed by field.
    func issues() -> [Field: String] {
        var issues: [Field: String] = [:]

        if portfolioId.isEmpty { issues[.portfolioId] = "Pick a portfolio" }
        if instrumentId.isEmpty { issues[.instrumentId] = "Pick an instrument" }

        if let issue = dateIssue(exDate) { issues[.exDate] = issue }
        // Optional: only validated once there is something to validate.
        if !payDate.trimmed().isEmpty, let issue = dateIssue(payDate) {
            issues[.payDate] = issue
        }

        // NORMALISED first, every time. `decimalIssue` documents that it takes
        // an already-normalised string, and the pl-PL keypad's comma is what
        // this user actually types — validating the raw value would refuse
        // "0,25" as "not a number" while the server accepted it happily.
        if let issue = decimalIssue(normalizeDecimalSeparator(quantity), .amount) {
            issues[.quantity] = issue
        }
        if let issue = decimalIssue(normalizeDecimalSeparator(amountPerShare), .amount) {
            issues[.amountPerShare] = issue
        }
        if let issue = decimalIssue(normalizeDecimalSeparator(grossAmount), .amount) {
            issues[.grossAmount] = issue
        }

        // Blank is a legitimate zero, so it is only checked when typed.
        let withheld = withheldTax.trimmed()
        if !withheld.isEmpty, let issue = decimalIssue(normalizeDecimalSeparator(withheld), .fee) {
            issues[.withheldTax] = issue
        }

        let rate = fxRateToBase.trimmed()
        if !rate.isEmpty, let issue = decimalIssue(normalizeDecimalSeparator(rate), .fxRate) {
            issues[.fxRateToBase] = issue
        }

        // Withheld tax above the gross would make net negative — a typo, and
        // the one cross-field rule the schema states (`refineWithheld`).
        // Compared on Decimal; the result is a sentence, not a figure.
        if issues[.withheldTax] == nil, issues[.grossAmount] == nil,
           let gross = dec(normalizeDecimalSeparator(grossAmount)),
           let tax = dec(normalizeDecimalSeparator(withheld.isEmpty ? "0" : withheld)),
           tax > gross {
            issues[.withheldTax] = "Withheld tax can't exceed the gross amount"
        }

        return issues
    }

    /// The optional-string convention this form and the server share: a blank
    /// field is ABSENT, never an empty string. `JSONEncoder` omits a nil,
    /// which is the encoding `z.preprocess` is written for.
    private func optional(_ value: String) -> String? {
        let trimmed = value.trimmed()
        return trimmed.isEmpty ? nil : normalizeDecimalSeparator(trimmed)
    }

    /// A blank note is absent too, but it is TEXT and must not go through the
    /// decimal-separator normaliser — a note reading "3,50 per share" would
    /// come back with a stop in it.
    private var noteValue: String? {
        let trimmed = note.trimmed()
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The create body, or nil when the draft would not pass its own checks.
    func createRequest() -> DividendCreateRequest? {
        guard issues().isEmpty else { return nil }
        return DividendCreateRequest(
            instrumentId: instrumentId,
            portfolioId: portfolioId,
            exDate: exDate.trimmed(),
            payDate: payDate.trimmed().isEmpty ? nil : payDate.trimmed(),
            quantity: normalizeDecimalSeparator(quantity.trimmed()),
            amountPerShare: normalizeDecimalSeparator(amountPerShare.trimmed()),
            grossAmount: normalizeDecimalSeparator(grossAmount.trimmed()),
            // Blank is the schema's zero, stated here so the wire carries a
            // number rather than relying on a preprocess the client cannot see.
            withheldTax: optional(withheldTax) ?? "0",
            currency: currency,
            fxRateToBase: optional(fxRateToBase),
            note: noteValue
        )
    }

    /// The edit body — no instrument, no currency. Both are locked server-side
    /// and sending them would be a fiction the handler merely happens to drop.
    func updateRequest() -> DividendUpdateRequest? {
        guard issues().isEmpty else { return nil }
        return DividendUpdateRequest(
            portfolioId: portfolioId,
            exDate: exDate.trimmed(),
            payDate: payDate.trimmed().isEmpty ? nil : payDate.trimmed(),
            quantity: normalizeDecimalSeparator(quantity.trimmed()),
            amountPerShare: normalizeDecimalSeparator(amountPerShare.trimmed()),
            grossAmount: normalizeDecimalSeparator(grossAmount.trimmed()),
            withheldTax: optional(withheldTax) ?? "0",
            fxRateToBase: optional(fxRateToBase),
            note: noteValue
        )
    }

    /// Seeded from a stored payment for the edit form.
    ///
    /// The amounts arrive as RAW decimal strings on purpose — the contract
    /// says so — because a grouped "1 234,50 zł" would have to be parsed back
    /// before it could be edited, and parsing money back is how a rounding
    /// difference is introduced.
    static func editing(_ payment: DividendPayment) -> DividendDraft {
        var draft = DividendDraft()
        draft.portfolioId = payment.portfolioId
        draft.instrumentId = payment.instrumentId
        draft.currency = Currency(rawValue: payment.currency) ?? .usd
        draft.exDate = payment.exDate
        draft.payDate = payment.payDate ?? ""
        draft.quantity = payment.quantity
        draft.amountPerShare = payment.amountPerShare
        draft.grossAmount = payment.grossAmount
        draft.withheldTax = payment.withheldTax
        draft.fxRateToBase = payment.fxRateToBase ?? ""
        draft.note = payment.note ?? ""
        return draft
    }
}
