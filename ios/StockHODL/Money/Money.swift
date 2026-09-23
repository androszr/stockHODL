import Foundation

/// The Swift side of non-negotiable #1: no float money math.
///
/// This mirrors `src/lib/money.ts` deliberately and closely. Every amount
/// arrives from the API as a decimal STRING (the generated contracts type them
/// as `String`, and that is not an accident), becomes a `Decimal` for
/// arithmetic, and becomes a `String` again for display. `Double` never touches
/// a price, a quantity, a fee or an FX rate.
///
/// The formatters are hand-rolled rather than handed to `Decimal.FormatStyle`,
/// and that needs justifying because it looks like reinvention:
///
///   - Polish CLDR carries `minimumGroupingDigits: 2`, so automatic grouping
///     leaves exactly the four-digit range bare — "4550,59 zł" one row above
///     "45 500,59 zł". `money.ts` fixes that with `useGrouping: 'always'`;
///     Foundation's `FormatStyle` has `.automatic` and `.never` and nothing
///     that means "always", so the bug the web already fixed would come back
///     on the phone with no way to switch it off.
///   - The output has to match the web CHARACTER FOR CHARACTER, because both
///     render the same portfolio and the user compares them. Pinning the rules
///     here makes that testable; leaning on ICU makes it a function of whatever
///     CLDR ships in the next OS release.
///
/// One honest difference from the web, in our favour: `money.ts` formats
/// `value.toNumber()`, so an amount with more than ~15 significant digits is
/// already a lossy `Double` by the time Intl sees it. Here the `Decimal` is
/// formatted directly. The two can only disagree past that boundary, and where
/// they do, this side is right.

// MARK: - Parsing and arithmetic

/// Parse a decimal string from the wire. `nil` when it is not a number —
/// callers decide what to render, and "—" beats a fabricated zero.
///
/// The POSIX locale is load-bearing. `Decimal(string:)` without one parses
/// according to the DEVICE locale, so on a Polish phone the "." in "110.25"
/// would be read as a group separator and the price would silently become
/// 11025.
func dec(_ string: String) -> Decimal? {
    Decimal(string: string, locale: Locale(identifier: "en_US_POSIX"))
}

/// Serialize back to the string form Postgres `numeric` expects.
func toNumeric(_ value: Decimal, scale: Int = 8) -> String {
    let negative = value < 0
    let (integer, fraction) = magnitudeDigits(abs(value), scale: scale)
    let body = scale > 0 ? "\(integer).\(fraction)" : integer
    return negative ? "-\(body)" : body
}

/// Percentage change from `from` to `to`, as a percentage rather than a ratio.
///
/// `nil` when `from` is zero: an undefined percentage must not render as a flat
/// 0,00%, which reads as "no change" instead of "unknown".
func pctChange(from: Decimal, to: Decimal) -> Decimal? {
    guard from != 0 else { return nil }
    return (to - from) / from * 100
}

/// Direction of a change, for token selection. Never infer a color from a
/// number — `Direction` is the generated contract's own enum, so the phone and
/// the server cannot disagree about what counts as a gain.
func directionOf(_ value: Decimal?) -> Direction {
    guard let value, value != 0 else { return .neutral }
    return value > 0 ? .gain : .loss
}

// MARK: - Formatting

private enum Format {
    /// pl-PL uses U+00A0 for BOTH the group separator and the gap before the
    /// currency. Escaped rather than typed, because an invisible character in
    /// source is exactly the kind of thing that silently rots.
    static let group = "\u{00A0}"
    static let decimal = ","

    /// What pl-PL actually prints for each currency this app supports — the
    /// closed list from `CURRENCIES` in `src/lib/validation.ts`. Only PLN and
    /// EUR have a symbol in this locale; the rest print their ISO code.
    static let currencySymbols: [String: String] = [
        "PLN": "zł",
        "EUR": "€",
    ]
}

/// Locale-formatted money. `fractionDigits` is 0 only for chart axes, where
/// cents are noise at a scale of hundreds of thousands; everything a user might
/// reconcile against a broker statement shows its cents.
func fmtMoney(_ value: Decimal, currency: String, fractionDigits: Int = 2) -> String {
    let unit = Format.currencySymbols[currency] ?? currency
    let number = plainNumber(value, minFractionDigits: fractionDigits, maxFractionDigits: fractionDigits)
    return "\(number)\(Format.group)\(unit)"
}

/// Locale-formatted plain number for unitless figures (greeks, ratios) that sit
/// beside money strings — same locale, same grouping, so mixed separators never
/// read as a rendering bug.
func fmtDecimal(_ value: Decimal, minFractionDigits: Int, maxFractionDigits: Int) -> String {
    plainNumber(value, minFractionDigits: minFractionDigits, maxFractionDigits: maxFractionDigits)
}

/// Quantities: up to eight decimals, trailing zeros dropped.
func fmtQuantity(_ value: Decimal) -> String {
    plainNumber(value, minFractionDigits: 0, maxFractionDigits: 8)
}

/// Locale-formatted percentage. `nil` is "—", the same as `pctChange` returning
/// nothing.
///
/// The sign rule mirrors Intl's `signDisplay: 'exceptZero'` exactly, including
/// its subtlety: the sign is decided AFTER rounding, so -0,004% prints as
/// "0,00%" and not "-0,00%". Money goes the other way — `signDisplay: 'auto'`
/// keeps the minus on a value that rounds to zero — and that asymmetry is
/// inherited, not invented.
func fmtPct(_ value: Decimal?) -> String {
    guard let value else { return "—" }

    let (integer, fraction) = magnitudeDigits(abs(value), scale: 2)
    let roundsToZero = integer.allSatisfy { $0 == "0" } && fraction.allSatisfy { $0 == "0" }

    let sign = roundsToZero ? "" : (value < 0 ? "-" : "+")
    return "\(sign)\(grouped(integer))\(Format.decimal)\(fraction)%"
}

/// Split a `fmtMoney` output into the number and its currency token, so a
/// caller can typeset the two differently — a tile wants "231,10" loud and
/// "USD" quiet, because on a grid of tiles the repeated currency is the least
/// informative glyph on screen.
///
/// String typesetting, never arithmetic: the amount is passed through verbatim
/// and NEVER parsed back. Safe for this app's single locale — pl-PL always puts
/// the currency last, separated by the same U+00A0 that groups thousands, so
/// the LAST whitespace is exactly the boundary. A string with no separator (an
/// em dash, an empty figure) comes back whole with an empty currency, so
/// callers never special-case "—".
func splitMoney(_ formatted: String) -> (amount: String, currency: String) {
    guard let at = formatted.lastIndex(where: { $0.isWhitespace }) else {
        return (amount: formatted, currency: "")
    }
    return (
        amount: String(formatted[formatted.startIndex..<at]),
        currency: String(formatted[formatted.index(after: at)...])
    )
}

// MARK: - The shared machinery

/// Sign, grouping and separators, applied once.
///
/// The sign is taken from the INPUT, not from the rounded result, which is what
/// makes -0,004 zł print as "-0,00 zł" the way Intl's default does.
private func plainNumber(
    _ value: Decimal,
    minFractionDigits: Int,
    maxFractionDigits: Int
) -> String {
    var (integer, fraction) = magnitudeDigits(abs(value), scale: maxFractionDigits)

    while fraction.count > minFractionDigits, fraction.hasSuffix("0") {
        fraction.removeLast()
    }

    let sign = value < 0 ? "-" : ""
    let body = fraction.isEmpty
        ? grouped(integer)
        : "\(grouped(integer))\(Format.decimal)\(fraction)"

    return "\(sign)\(body)"
}

/// A non-negative `Decimal` as its integer and fraction digits, rounded to
/// `scale` and zero-padded to it.
///
/// `.plain` on a MAGNITUDE is unambiguously round-half-up — which is what a
/// broker statement does, and what `Decimal.set({ rounding: ROUND_HALF_UP })`
/// asks for in `money.ts`. Rounding the magnitude rather than the signed value
/// is the point: it sidesteps the question of which way `.plain` breaks a tie
/// below zero.
private func magnitudeDigits(_ magnitude: Decimal, scale: Int) -> (integer: String, fraction: String) {
    var input = magnitude
    var rounded = Decimal()
    NSDecimalRound(&rounded, &input, scale, .plain)

    // `Decimal`'s own description is locale-independent: a plain "1234.5" with
    // a period, never exponent notation at these magnitudes.
    let text = "\(rounded)"
    let split = text.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)

    let integer = String(split[0])
    var fraction = split.count > 1 ? String(split[1]) : ""

    if fraction.count > scale { fraction = String(fraction.prefix(scale)) }
    fraction += String(repeating: "0", count: max(0, scale - fraction.count))

    return (integer, fraction)
}

/// Group separators every three digits, unconditionally.
///
/// Unconditional is the whole point: pl-PL's `minimumGroupingDigits: 2` would
/// leave four-digit values bare, and on a holdings column that inconsistency
/// reads as a rendering bug. Same decision as `GROUPING` in `money.ts`.
private func grouped(_ digits: String) -> String {
    guard digits.count > 3 else { return digits }

    var out: [Character] = []
    for (offset, character) in digits.reversed().enumerated() {
        if offset > 0, offset % 3 == 0 { out.append(contentsOf: Format.group.reversed()) }
        out.append(character)
    }
    return String(out.reversed())
}
