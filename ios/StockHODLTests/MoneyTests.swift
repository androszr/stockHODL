import Foundation
import Testing

@testable import StockHODL

/// Ported case-for-case from `src/lib/money.test.ts`.
///
/// The port is the point. Both clients render the same portfolio, and a user
/// who has the web app open next to the phone will read the two figures as one
/// number. So a divergence here is not "a platform difference" — it is a bug on
/// whichever side moved.
///
/// Separators are written as escapes, never as typed characters: pl-PL uses
/// U+00A0 for both grouping and the currency gap, and a plain space pasted in
/// its place is invisible in a diff while silently breaking the assertion.
@Suite("Money")
struct MoneyTests {
    /// Force-unwraps a decimal LITERAL used as test input. A malformed literal
    /// here is a typo in the test, and trapping on it is the right failure —
    /// nesting `#require` inside `#expect` is not (the macros recurse).
    private func d(_ string: String) -> Decimal {
        guard let value = dec(string) else {
            fatalError("test literal \(string) is not a decimal")
        }
        return value
    }

    // MARK: dec

    @Test("keeps precision that a floating-point number would destroy")
    func precision() {
        #expect(d("0.1") + d("0.2") == d("0.3"))
    }

    @Test("round-trips a numeric string without drift")
    func roundTrip() {
        #expect(toNumeric(d("1234.56789012")) == "1234.56789012")
    }

    @Test("refuses what is not a number rather than inventing a zero")
    func rejectsGarbage() {
        #expect(dec("") == nil)
        #expect(dec("abc") == nil)
    }

    @Test("reads the wire's decimal point regardless of the device locale")
    func posixParsing() {
        // The failure this pins: `Decimal(string:)` without an explicit locale
        // parses by DEVICE locale, and on a Polish phone "110.25" would come
        // back as 11025 — a hundredfold price error, silently.
        #expect(d("110.25") == Decimal(string: "110.25", locale: Locale(identifier: "en_US_POSIX")))
        #expect(d("110.25") * 100 == d("11025"))
    }

    // MARK: pctChange

    @Test("computes a positive change")
    func positiveChange() throws {
        let change = try #require(pctChange(from: d("100"), to: d("110")))
        #expect(fmtDecimal(change, minFractionDigits: 2, maxFractionDigits: 2) == "10,00")
    }

    @Test("computes a negative change")
    func negativeChange() throws {
        let change = try #require(pctChange(from: d("100"), to: d("90")))
        #expect(fmtDecimal(change, minFractionDigits: 2, maxFractionDigits: 2) == "-10,00")
    }

    @Test("returns nil rather than 0 when the base is zero")
    func zeroBase() {
        // A zero base means "undefined", which must not render as a flat 0,00%.
        #expect(pctChange(from: d("0"), to: d("10")) == nil)
    }

    // MARK: fmtPct

    @Test("signs gains explicitly")
    func signsGains() {
        #expect(fmtPct(d("3.456")) == "+3,46%")
    }

    @Test("does not double-sign losses")
    func signsLosses() {
        #expect(fmtPct(d("-3.456")) == "-3,46%")
    }

    @Test("renders an em dash for an undefined change")
    func undefinedChange() {
        #expect(fmtPct(nil) == "—")
    }

    @Test("treats exact zero as unsigned")
    func unsignedZero() {
        #expect(fmtPct(d("0")) == "0,00%")
    }

    @Test("drops the sign from a percent that rounds to zero")
    func percentRoundingToZero() {
        // Intl's `signDisplay: 'exceptZero'` decides the sign AFTER rounding,
        // so this is "0,00%" and not "-0,00%". Money goes the other way — see
        // below — and the asymmetry is inherited, not invented.
        #expect(fmtPct(d("-0.001")) == "0,00%")
        #expect(fmtPct(d("0.001")) == "0,00%")
    }

    @Test("uses the same separators as fmtMoney")
    func sharedSeparators() {
        #expect(fmtPct(d("51150")) == "+51\u{00A0}150,00%")
        #expect(fmtMoney(d("23708.11"), currency: "PLN") == "23\u{00A0}708,11\u{00A0}zł")
    }

    // MARK: grouping

    @Test("groups four-digit values, which pl-PL would otherwise leave bare")
    func fourDigitGrouping() {
        // Polish CLDR carries `minimumGroupingDigits: 2`, so DEFAULT grouping
        // leaves exactly this range bare — "+4550,59 zł" one row above
        // "45 500,59 zł". Four digits is the only width that regresses, so it
        // is the only width worth pinning.
        #expect(fmtMoney(d("4550.59"), currency: "PLN") == "4\u{00A0}550,59\u{00A0}zł")
        #expect(fmtQuantity(d("1500")) == "1\u{00A0}500")
        #expect(fmtPct(d("4550.59")) == "+4\u{00A0}550,59%")
    }

    @Test("groups every three digits, not just the first three")
    func wideGrouping() {
        #expect(fmtMoney(d("1000000"), currency: "USD") == "1\u{00A0}000\u{00A0}000,00\u{00A0}USD")
    }

    // MARK: fmtMoney

    @Test("prints the currency token pl-PL actually uses")
    func currencyTokens() {
        let value = d("231.1")
        #expect(fmtMoney(value, currency: "PLN") == "231,10\u{00A0}zł")
        #expect(fmtMoney(value, currency: "EUR") == "231,10\u{00A0}€")
        #expect(fmtMoney(value, currency: "USD") == "231,10\u{00A0}USD")
        #expect(fmtMoney(value, currency: "GBP") == "231,10\u{00A0}GBP")
        #expect(fmtMoney(value, currency: "CHF") == "231,10\u{00A0}CHF")
    }

    @Test("rounds half away from zero, the way a broker statement does")
    func halfUpRounding() {
        #expect(fmtMoney(d("2.675"), currency: "PLN") == "2,68\u{00A0}zł")
        #expect(fmtMoney(d("-2.675"), currency: "PLN") == "-2,68\u{00A0}zł")
        #expect(fmtMoney(d("0.005"), currency: "PLN") == "0,01\u{00A0}zł")
    }

    @Test("keeps the minus on money that rounds to zero")
    func moneyRoundingToZero() {
        // The counterpart to the percent case above: a loss too small to show
        // is still a loss, and Intl's default sign behaviour says so.
        #expect(fmtMoney(d("-0.001"), currency: "PLN") == "-0,00\u{00A0}zł")
    }

    @Test("drops the cents only where a chart axis asks for it")
    func axisFormatting() {
        #expect(fmtMoney(d("45500.5"), currency: "PLN", fractionDigits: 0) == "45\u{00A0}501\u{00A0}zł")
    }

    // MARK: fmtQuantity

    @Test("shows up to eight decimals and no trailing zeros")
    func quantityPrecision() {
        #expect(fmtQuantity(d("0.12345678")) == "0,12345678")
        #expect(fmtQuantity(d("1234.500000001")) == "1\u{00A0}234,5")
        #expect(fmtQuantity(d("-0.5")) == "-0,5")
        #expect(fmtQuantity(d("10")) == "10")
    }

    // MARK: directionOf

    @Test("maps sign to a token name")
    func direction() {
        #expect(directionOf(d("1")) == .gain)
        #expect(directionOf(d("-1")) == .loss)
        #expect(directionOf(d("0")) == .neutral)
        #expect(directionOf(nil) == .neutral)
    }

    // MARK: splitMoney

    @Test("splits real fmtMoney output, including grouped amounts")
    func splitsGrouped() {
        // The group separator is the SAME U+00A0 as the currency separator, so
        // a naive "first space" split would cut after "1".
        let formatted = fmtMoney(d("1234567.5"), currency: "USD")
        let split = splitMoney(formatted)
        #expect(split.currency == "USD")
        #expect(split.amount == "1\u{00A0}234\u{00A0}567,50")

        #expect(splitMoney(fmtMoney(d("231.1"), currency: "PLN")).currency == "zł")
        #expect(splitMoney(fmtMoney(d("-231.1"), currency: "USD")).currency == "USD")
    }

    @Test("rejoins to exactly the original string — nothing is lost in the split")
    func splitIsLossless() {
        for currency in ["USD", "PLN", "EUR", "GBP", "CHF"] {
            let formatted = fmtMoney(d("9876543.21"), currency: currency)
            let split = splitMoney(formatted)
            #expect("\(split.amount)\u{00A0}\(split.currency)" == formatted)
        }
    }

    @Test("a figure with no currency token comes back whole")
    func splitsUnpriced() {
        // The unpriced case: callers render "—" through the same path.
        let split = splitMoney("—")
        #expect(split.amount == "—")
        #expect(split.currency == "")
    }
}
