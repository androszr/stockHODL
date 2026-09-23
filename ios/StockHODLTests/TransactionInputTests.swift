import Foundation
import Testing

@testable import StockHODL

/// The port of `src/lib/validation.ts`, held to the original's own cases.
///
/// The server revalidates everything, so none of this is load-bearing for
/// correctness. It is load-bearing for TRUST: a client rule that is merely
/// close to the server's produces a form that refuses a value the server would
/// have taken, or accepts one it will not — and the second is worse, because
/// the user finds out after tapping Save.
@Suite("Transaction input")
struct TransactionInputTests {
    // MARK: - Separator normalisation

    @Test("a lone comma is the decimal point, because the pl-PL keypad has no dot")
    func commaIsDecimal() {
        #expect(normalizeDecimalSeparator("182,40") == "182.40")
        #expect(normalizeDecimalSeparator("  0,5  ") == "0.5")
    }

    @Test("thousands grouping is refused, never guessed at")
    func groupingRefused() {
        // Normalising "1,000" to 1 would be a 1000x error with no warning, so
        // the value is left alone and rejected by name.
        #expect(normalizeDecimalSeparator("1,000") == "1,000")
        #expect(decimalIssue("1,000", .amount)?.hasPrefix("That reads as a thousands separator") == true)
        #expect(decimalIssue("-12,345", .amount) != nil)
    }

    @Test("a zero integer part is never grouping — fractional shares stay typeable")
    func zeroIntegerCarveOut() {
        // Nobody writes 0,125 to mean 125, and this is the carve-out that keeps
        // fractional-share entry possible on a keypad whose only separator is
        // the comma.
        #expect(normalizeDecimalSeparator("0,125") == "0.125")
        #expect(decimalIssue(normalizeDecimalSeparator("0,125"), .amount) == nil)
    }

    @Test("anything mixed or repeated is left alone and fails the decimal check")
    func ambiguousLeftAlone() {
        #expect(normalizeDecimalSeparator("1.234,5") == "1.234,5")
        #expect(normalizeDecimalSeparator("1,2,3") == "1,2,3")
        #expect(decimalIssue("1.234,5", .amount) == "Enter a valid number")
    }

    // MARK: - Bounds

    @Test("a price must be greater than zero; a fee only non-negative")
    func signBounds() {
        #expect(decimalIssue("0", .amount) == "Must be greater than zero")
        #expect(decimalIssue("-1", .amount) == "Must be greater than zero")
        #expect(decimalIssue("0", .fee) == nil)
        #expect(decimalIssue("-0.01", .fee) == "Must not be negative")
    }

    @Test("a value too small to store is refused rather than silently rounded to zero")
    func tooSmallToStore() {
        // Persisting a zero-quantity trade that validation swore was positive
        // would be a data hole with nothing pointing at it.
        #expect(decimalIssue("0.000000001", .amount)?.hasPrefix("Too small to store") == true)
        #expect(decimalIssue("0.00000001", .amount) == nil)
    }

    @Test("scale and magnitude are bounded by what the column can hold")
    func storageBounds() {
        #expect(decimalIssue("1.123456789", .amount) == "Use at most 8 decimal places")
        #expect(decimalIssue("1000000000000", .amount) == "Keep the value under 12 digits")
        // Trailing zeros are not places — the server counts significant ones.
        #expect(decimalIssue("10.500000000", .amount) == nil)
    }

    @Test("the FX rate gets its own, wider bounds — numeric(20,10)")
    func fxBounds() {
        #expect(decimalIssue("4.0512345678", .fxRate) == nil)
        #expect(decimalIssue("4.05123456789", .fxRate) == "Use at most 10 decimal places")
        #expect(decimalIssue("0", .fxRate) == "Must be greater than zero")
    }

    // MARK: - Dates

    @Test("a trade date must exist, not merely look like one")
    func dateValidity() {
        #expect(dateIssue("2026-03-04") == nil)
        #expect(dateIssue("2026-2-4") == "Use the YYYY-MM-DD format")
        #expect(dateIssue("not a date") == "Use the YYYY-MM-DD format")
        // The shape check cannot catch this and a DateFormatter would happily
        // roll it over into March.
        #expect(dateIssue("2026-02-30") == "That date does not exist")
        // A leap year that is one.
        #expect(dateIssue("2028-02-29") == nil)
        #expect(dateIssue("2026-02-29") == "That date does not exist")
    }

    // MARK: - The draft as a whole

    private func draft() -> TransactionDraft {
        var draft = TransactionDraft()
        draft.portfolioId = "22222222-2222-4222-8222-222222222222"
        draft.symbol = "aapl"
        draft.displayName = "Apple Inc."
        draft.exchange = "NASDAQ"
        draft.currency = .usd
        draft.quantity = "10"
        draft.price = "182,40"
        draft.tradeDate = "2026-03-04"
        draft.fxRateToBase = "4,05"
        return draft
    }

    @Test("a complete draft becomes a normalised body")
    func normalisedBody() throws {
        let request = try #require(draft().request())

        #expect(request.symbol == "AAPL")
        #expect(request.price == "182.40")
        #expect(request.fxRateToBase == "4.05")
        // An empty fee is zero, not a mistake — the server's own preprocess.
        #expect(request.fees == "0")
        // An empty note is absent, not an empty string.
        #expect(request.note == nil)
    }

    @Test("PLN forces the rate to 1 and never asks for it")
    func plnForcesOne() throws {
        var draft = self.draft()
        draft.currency = .pln
        draft.fxRateToBase = "9999"

        #expect(!draft.needsFxRate)
        // Whatever is in the field is ignored rather than validated — the same
        // transform the server applies.
        #expect(try #require(draft.request()).fxRateToBase == "1")
    }

    @Test("a non-PLN currency without a rate is refused before the round trip")
    func fxRequired() {
        var draft = self.draft()
        draft.fxRateToBase = ""

        #expect(draft.issues()[.fxRateToBase] == "FX rate to PLN is required for a non-PLN currency")
        #expect(draft.request() == nil)
    }

    @Test("every empty required field names itself")
    func emptyDraft() {
        let issues = TransactionDraft().issues()

        #expect(issues[.portfolioId] == "Pick a portfolio")
        #expect(issues[.symbol] == "Symbol is required")
        #expect(issues[.displayName] == "Name is required")
        #expect(issues[.exchange] == "Exchange is required")
        #expect(issues[.quantity] == "Enter a valid number")
        #expect(issues[.tradeDate] == "Use the YYYY-MM-DD format")
        // A fee is the one amount an empty value is a valid answer for.
        #expect(issues[.fees] == nil)
    }

    @Test("the body encodes as the server's own field names")
    func wireShape() throws {
        let data = try JSONEncoder().encode(try #require(draft().request()))
        let json = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        // A renamed field here is a 400 the client cannot explain, so the keys
        // are worth pinning rather than trusting to Codable's synthesis.
        #expect(json["fxRateToBase"] as? String == "4.05")
        #expect(json["tradeDate"] as? String == "2026-03-04")
        #expect(json["side"] as? String == "buy")
        #expect(json["currency"] as? String == "USD")
        // Money on the wire is a string. Always.
        #expect(json["price"] is String)
        #expect(json["quantity"] is String)
    }

    @Test("the currency picker offers exactly the server's closed list")
    func currencyList() {
        // A typo'd code would bind the symbol permanently — `instruments` is
        // global and first-write-wins — and NBP has no rate for it.
        #expect(Set(Currency.allCases.map(\.rawValue)) == ["PLN", "USD", "EUR", "GBP", "CHF"])
    }
}
