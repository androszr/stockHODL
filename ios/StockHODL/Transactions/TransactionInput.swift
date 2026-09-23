import Foundation

/// The transaction write body, and the rules it has to satisfy.
///
/// `src/lib/validation.ts` is the spec, and the server remains AUTHORITATIVE —
/// `transactionInputSchema` runs again on every request, so nothing here can
/// let a bad value through. What this buys is the difference between a field
/// turning red as you leave it and a round trip that comes back with
/// "quantity: Must be greater than zero" after you have already tapped Save.
///
/// Ported rule for rule, including the two that look like quirks and are not:
/// the thousands-grouping refusal, and the comma-as-decimal-separator
/// normalisation the pl-PL numeric pad forces on us.
///
/// Every check runs on `Decimal`. There is no `Double` in this file and there
/// must never be one — non-negotiable #1 applies hardest exactly here, where a
/// user-typed price becomes a stored amount.

// MARK: - Separator normalisation

/// A comma followed by exactly three digits at the end, with a non-zero
/// integer part: '1,000', '12,345'. Indistinguishable from thousands grouping,
/// and normalising it would silently store 1 instead of 1000 — a 1000× error
/// with no warning. We refuse to guess.
///
/// The carve-out for a '0' integer part is deliberate and inherited: nobody
/// writes 0,125 to mean 125, so '0,125' stays a valid decimal. That is what
/// keeps fractional-share entry possible on a keypad whose only separator key
/// is the comma.
/// Spelled out rather than as a regex, because the shape is three cheap facts
/// and the equivalent pattern (`^-?(?!0,)\d+,\d{3}$`) hides a lookahead that
/// nobody reads twice the same way.
private func looksLikeGrouping(_ value: String) -> Bool {
    var body = Substring(value)
    if body.hasPrefix("-") { body = body.dropFirst() }

    guard let comma = body.firstIndex(of: ",") else { return false }
    let integer = body[body.startIndex..<comma]
    let fraction = body[body.index(after: comma)...]

    guard !integer.isEmpty, integer.allSatisfy(\.isASCIIDigit) else { return false }
    guard fraction.count == 3, fraction.allSatisfy(\.isASCIIDigit) else { return false }
    // The carve-out: nobody writes 0,125 to mean 125.
    return integer != "0"
}

extension Character {
    /// `isNumber` is true for "٣" and "½". A digit here means a digit.
    var isASCIIDigit: Bool { isASCII && isNumber }
}

/// The pl-PL numeric pad offers only a COMMA, so a lone comma must be accepted
/// as the decimal point. Normalised once, here — never at a call site. Exactly
/// one comma and no dot is unambiguous; anything mixed ('1.234,5') or repeated
/// ('1,2,3') is left alone and fails the decimal check rather than being
/// guessed at.
func normalizeDecimalSeparator(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if looksLikeGrouping(trimmed) { return trimmed }
    guard let comma = trimmed.firstIndex(of: ","), !trimmed.contains(".") else { return trimmed }
    // The FIRST comma only, mirroring `String.replace(',', '.')` on the
    // server. Replacing all of them would turn "1,2,3" into the plausible-
    // looking "1.2.3" instead of leaving it to fail the decimal check.
    var swapped = trimmed
    swapped.replaceSubrange(comma...comma, with: ".")
    return swapped.contains(",") ? trimmed : swapped
}

// MARK: - Decimal bounds

struct DecimalBounds {
    var positive = false
    var nonNegative = false
    /// Max digits before the separator. 12 stays well inside numeric(20,8).
    var maxIntegerDigits = 12
    /// Max digits after the separator — the storage scale.
    var maxScale = 8

    /// What a money or quantity field allows.
    static let amount = DecimalBounds(positive: true)
    static let fee = DecimalBounds(nonNegative: true)
    /// `fx_rate_to_base` is numeric(20,10).
    static let fxRate = DecimalBounds(positive: true, maxIntegerDigits: 10, maxScale: 10)
}

/// The issue with an already-normalised decimal string, or nil when it is
/// fine. Messages are the server's own, word for word: a rule that reads
/// differently in two places is a rule the user has to learn twice.
func decimalIssue(_ value: String, _ bounds: DecimalBounds) -> String? {
    if looksLikeGrouping(value) {
        return "That reads as a thousands separator — enter the number without grouping (e.g. 1000 or 1000,50)"
    }
    guard let amount = strictDecimal(value) else { return "Enter a valid number" }

    if bounds.positive, amount <= 0 { return "Must be greater than zero" }
    if bounds.nonNegative, amount < 0 { return "Must not be negative" }

    if abs(amount) >= pow(Decimal(10), bounds.maxIntegerDigits) {
        return "Keep the value under \(bounds.maxIntegerDigits) digits"
    }

    // A non-zero value must survive storage rounding: silently persisting a
    // zero-quantity trade that validation swore was positive is a data hole.
    var rounded = Decimal()
    var input = amount
    NSDecimalRound(&rounded, &input, bounds.maxScale, .plain)
    if amount != 0, rounded == 0 {
        return "Too small to store — the smallest step is 1e-\(bounds.maxScale)"
    }

    if decimalPlaces(of: value) > bounds.maxScale {
        return "Use at most \(bounds.maxScale) decimal places"
    }
    return nil
}

/// A decimal string that is a decimal string ALL THE WAY THROUGH.
///
/// `dec()` cannot be used here, and the difference bites: `Decimal(string:)`
/// parses the longest valid prefix, so "1.234,5" comes back as 1.234 and a
/// half-typed value would sail through validation as a plausible smaller
/// number. `dec()` is right for server-produced amounts, which are never
/// malformed; user input is exactly the case it is wrong for.
/// Internal, not fileprivate: `TargetEditSheet` sums user-typed percents with
/// this exact parser, and a second copy of "what counts as a number here"
/// would be a second rule to keep in step. `normalizeDecimalSeparator` and
/// `decimalIssue` above are internal for the same reason.
func strictDecimal(_ value: String) -> Decimal? {
    var body = Substring(value)
    if body.hasPrefix("-") { body = body.dropFirst() }
    guard !body.isEmpty else { return nil }

    let parts = body.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count <= 2 else { return nil }
    guard !parts[0].isEmpty, parts[0].allSatisfy(\.isASCIIDigit) else { return nil }
    if parts.count == 2 {
        guard !parts[1].isEmpty, parts[1].allSatisfy(\.isASCIIDigit) else { return nil }
    }
    return dec(value)
}

/// Significant decimal places, trailing zeros ignored — which is what
/// `Decimal.decimalPlaces()` reports on the server, so "10.500000000" is one
/// place there and must be one place here too.
private func decimalPlaces(of value: String) -> Int {
    guard let dot = value.firstIndex(of: ".") else { return 0 }
    var fraction = Substring(value[value.index(after: dot)...])
    while fraction.hasSuffix("0") { fraction = fraction.dropLast() }
    return fraction.count
}

// MARK: - The draft

/// What the form holds while it is being filled in: strings, all of them,
/// exactly as typed. Nothing is parsed until it is validated, and nothing is
/// reformatted under the user's cursor.
struct TransactionDraft: Sendable, Equatable {
    var portfolioId = ""
    var side: TransactionSide = .buy
    var symbol = ""
    var displayName = ""
    var exchange = ""
    var currency: Currency = .usd
    var quantity = ""
    var price = ""
    var fees = ""
    var tradeDate = ""
    var fxRateToBase = ""
    var note = ""

    /// The fields a form can point at. `rawValue` is the server's own path, so
    /// a 400 like `quantity: Must be greater than zero` maps straight back to
    /// the field that produced it.
    enum Field: String, Sendable, CaseIterable {
        case portfolioId
        case symbol
        case displayName
        case exchange
        case quantity
        case price
        case fees
        case tradeDate
        case fxRateToBase
        case note
    }

    /// PLN is the base currency, so its rate is exactly '1' and the field is
    /// not shown at all. Anything the client might have left in it is ignored
    /// rather than validated — the same transform the server applies.
    var needsFxRate: Bool { currency != .pln }
}

/// The body as it goes on the wire: normalised, and nothing else.
struct TransactionRequest: Encodable, Sendable, Equatable {
    let portfolioId: String
    let side: TransactionSide
    let symbol: String
    let displayName: String
    let exchange: String
    let currency: Currency
    let quantity: String
    let price: String
    let fees: String
    let tradeDate: String
    let fxRateToBase: String
    let note: String?
}

extension TransactionDraft {
    /// Every problem with the draft, keyed by field. Empty means it is ready
    /// to send — and the server will still say so for itself.
    func issues() -> [Field: String] {
        var issues: [Field: String] = [:]

        if portfolioId.isEmpty { issues[.portfolioId] = "Pick a portfolio" }

        let symbol = self.symbol.trimmed().uppercased()
        if symbol.isEmpty {
            issues[.symbol] = "Symbol is required"
        } else if symbol.count > 20 {
            issues[.symbol] = "Keep the symbol under 20 characters"
        }

        if displayName.trimmed().isEmpty {
            issues[.displayName] = "Name is required"
        } else if displayName.trimmed().count > 80 {
            issues[.displayName] = "Keep the name under 80 characters"
        }

        if exchange.trimmed().isEmpty {
            issues[.exchange] = "Exchange is required"
        } else if exchange.trimmed().count > 20 {
            issues[.exchange] = "Keep the exchange under 20 characters"
        }

        if let issue = decimalIssue(normalizeDecimalSeparator(quantity), .amount) {
            issues[.quantity] = issue
        }
        if let issue = decimalIssue(normalizeDecimalSeparator(price), .amount) {
            issues[.price] = issue
        }

        // An empty fee is zero, not a mistake. Same preprocess as the server's.
        let fees = normalizeDecimalSeparator(self.fees)
        if let issue = decimalIssue(fees.isEmpty ? "0" : fees, .fee) {
            issues[.fees] = issue
        }

        if let issue = dateIssue(tradeDate) { issues[.tradeDate] = issue }

        if needsFxRate {
            let rate = normalizeDecimalSeparator(fxRateToBase)
            if rate.isEmpty {
                issues[.fxRateToBase] = "FX rate to PLN is required for a non-PLN currency"
            } else if let issue = decimalIssue(rate, .fxRate) {
                issues[.fxRateToBase] = issue
            }
        }

        if note.trimmed().count > 500 { issues[.note] = "Keep the note under 500 characters" }

        return issues
    }

    /// The request body, or nil when the draft still has problems. Callers ask
    /// `issues()` for the reasons; this returning nil is never the explanation
    /// shown to a user.
    func request() -> TransactionRequest? {
        guard issues().isEmpty else { return nil }

        let fees = normalizeDecimalSeparator(self.fees)
        let trimmedNote = note.trimmed()

        return TransactionRequest(
            portfolioId: portfolioId,
            side: side,
            symbol: symbol.trimmed().uppercased(),
            displayName: displayName.trimmed(),
            exchange: exchange.trimmed(),
            currency: currency,
            quantity: normalizeDecimalSeparator(quantity),
            price: normalizeDecimalSeparator(price),
            fees: fees.isEmpty ? "0" : fees,
            tradeDate: tradeDate,
            // PLN forces '1' regardless of what is in the field.
            fxRateToBase: needsFxRate ? normalizeDecimalSeparator(fxRateToBase) : "1",
            note: trimmedNote.isEmpty ? nil : trimmedNote
        )
    }
}

/// 'YYYY-MM-DD', and a date that actually exists.
///
/// Kept as a plain string end to end, never round-tripped through `Date`:
/// converting would shift the day in every zone west of UTC, which is how a
/// trade booked on the 1st quietly becomes the 31st.
func dateIssue(_ value: String) -> String? {
    let parts = value.split(separator: "-", omittingEmptySubsequences: false)
    let shaped = parts.count == 3
        && parts[0].count == 4 && parts[1].count == 2 && parts[2].count == 2
        && parts.allSatisfy { $0.allSatisfy(\.isASCIIDigit) }
    guard shaped else { return "Use the YYYY-MM-DD format" }

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!

    let numbers = parts.compactMap { Int($0) }
    guard numbers.count == 3 else { return "That date does not exist" }
    let components = DateComponents(year: numbers[0], month: numbers[1], day: numbers[2])
    // `isValidDate` is what catches 2026-02-30: the format check above cannot,
    // and `DateFormatter` would happily roll it over to March.
    return components.isValidDate(in: calendar) ? nil : "That date does not exist"
}

extension Currency: CaseIterable {
    /// The closed list from `CURRENCIES` in `src/lib/validation.ts`, in the
    /// order a picker should offer it: the base currency first, then by how
    /// often this portfolio actually uses them.
    ///
    /// Spelled out rather than synthesised because the enum is generated and
    /// `CaseIterable` can only be synthesised in the declaring file. The build
    /// fails if a case is added there and not here, which is the right way
    /// round — a silently missing picker entry would be worse.
    static var allCases: [Currency] { [.pln, .usd, .eur, .gbp, .chf] }
}

extension String {
    func trimmed() -> String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
