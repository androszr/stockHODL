import Foundation

/// The change a chart reports: across the whole visible window above the
/// plot, and from the window's first point to the scrubbed one in the callout.
///
/// Arithmetic on `Decimal` only, from the decimal STRING each `PlotPoint`
/// carries as `raw`. This file never sees the plotted coordinates — they are
/// geometry, and a subtraction of two of them would be the float-money bug
/// the CI grep cannot catch (it looks for a conversion, not a subtraction).
///
/// `percent` is `nil` whenever a ratio would lie: a zero or negative baseline
/// in money mode, and ALWAYS in percent mode, where the plotted quantity is
/// already a return and `absolute` is the percentage-point delta.
struct ChartChange: Equatable, Sendable {
    let absolute: Decimal
    let percent: Decimal?
}

enum ChartChanges {
    // MARK: - Arithmetic

    /// `from` → `to`, both decimal strings off the wire. `nil` when either
    /// will not parse — the caller omits the line rather than printing "—".
    static func change(from: String, to: String, unit: ChartUnit) -> ChartChange? {
        guard let a = dec(from), let b = dec(to) else { return nil }
        let absolute = b - a
        switch unit {
        case .money, .rate:
            // A zero baseline has no percentage, and a NEGATIVE one flips the
            // sign of the ratio — "+100 from -50" would print as -200 %. The
            // `> 0` guard refuses both; the amount alone is still honest. A
            // rate is the same shape: a ratio of two positive quotes.
            return ChartChange(absolute: absolute, percent: a > 0 ? pctChange(from: a, to: b) : nil)
        case .percent:
            // A percent of a percent is meaningless; the delta IS the figure.
            return ChartChange(absolute: absolute, percent: nil)
        }
    }

    /// Last visible point against the first — the same pair the dashed
    /// baseline and the stroke colour are measured from.
    static func window(_ plotted: [PlotPoint], unit: ChartUnit) -> ChartChange? {
        guard plotted.count >= 2 else { return nil }
        return change(from: plotted[0].raw, to: plotted[plotted.count - 1].raw, unit: unit)
    }

    /// The scrubbed point against the window's first. Scrubbing the first
    /// point itself yields a flat zero, which is shown, not hidden: "0,00%
    /// since 1 sie" is the true answer there.
    static func sinceStart(of point: PlotPoint, in plotted: [PlotPoint], unit: ChartUnit) -> ChartChange? {
        guard let first = plotted.first else { return nil }
        return change(from: first.raw, to: point.raw, unit: unit)
    }

    // MARK: - Formatters

    /// U+00A0, escaped rather than typed — the same character `Money.swift`
    /// groups with, and just as invisible in a diff.
    private static let nbsp = "\u{00A0}"

    /// Whether a formatted magnitude carries any non-zero digit. Decided on the
    /// ROUNDED text so the sign follows what is printed: `+0,004 zł` rounds to
    /// nothing and must print as "0,00 zł", never "+0,00 zł" — the same
    /// `exceptZero` rule `fmtPct` follows.
    private static func isAllZero(_ formatted: String) -> Bool {
        !formatted.contains { $0.isNumber && $0 != "0" }
    }

    private static func sign(for value: Decimal, body: String) -> String {
        if isAllZero(body) { return "" }
        return value < 0 ? "-" : "+"
    }

    /// What the figure will print as, before any sign — the text the sign
    /// and the colour are both decided on.
    private static func body(of change: ChartChange, unit: ChartUnit, currency: String) -> String {
        switch unit {
        case .money: fmtMoney(abs(change.absolute), currency: currency)
        case .percent: fmtDecimal(abs(change.absolute), minFractionDigits: 2, maxFractionDigits: 2)
        case .rate: rateBody(abs(change.absolute))
        }
    }

    /// The colour for a change, decided on the ROUNDED text like the sign is:
    /// a delta of 0,004 prints "0,00 zł" with no sign, and painting that
    /// green would make colour say what the figure does not. Everything that
    /// does print a digit goes through the same `directionOf` every other
    /// gain/loss signal uses.
    static func directionOf(_ change: ChartChange, unit: ChartUnit, currency: String) -> Direction {
        if isAllZero(body(of: change, unit: unit, currency: currency)) { return .neutral }
        return StockHODL.directionOf(change.absolute)
    }

    /// Money with an explicit leading sign: "+12,40 zł", "-12,40 zł",
    /// "0,00 zł". The sign is decided AFTER rounding.
    static func signedMoney(_ value: Decimal, currency: String) -> String {
        let body = fmtMoney(abs(value), currency: currency)
        return sign(for: value, body: body) + body
    }

    /// Four fraction digits, unsigned — the rate register: "0,0045".
    private static func rateBody(_ value: Decimal) -> String {
        fmtDecimal(value, minFractionDigits: 4, maxFractionDigits: 4)
    }

    /// A rate delta with an explicit leading sign: "+0,0045", "-0,0045",
    /// "0,0000". Four digits, no currency — a move in USD/PLN lives in the
    /// third and fourth decimal and "+0,00 zł" would print every day as flat.
    /// The sign is decided AFTER rounding, like `signedMoney`.
    static func signedRate(_ value: Decimal) -> String {
        let body = rateBody(abs(value))
        return sign(for: value, body: body) + body
    }

    /// Percentage points, for the Return chart: "+3,12 pp". Same sign rule.
    static func points(_ value: Decimal) -> String {
        let body = fmtDecimal(abs(value), minFractionDigits: 2, maxFractionDigits: 2)
        return sign(for: value, body: body) + body + nbsp + "pp"
    }

    /// The row above the plot: "+12,40 zł  +3,12%  past month". The percent
    /// part is absent when there is no honest percent; the label is absent
    /// when the caller has none.
    static func windowLine(
        _ change: ChartChange?,
        unit: ChartUnit,
        currency: String,
        windowLabel: String?
    ) -> String? {
        guard let change else { return nil }
        var parts: [String] = []
        switch unit {
        case .money:
            parts.append(signedMoney(change.absolute, currency: currency))
            if let percent = change.percent { parts.append(fmtPct(percent)) }
        case .rate:
            parts.append(signedRate(change.absolute))
            if let percent = change.percent { parts.append(fmtPct(percent)) }
        case .percent:
            parts.append(points(change.absolute))
        }
        if let windowLabel { parts.append(windowLabel) }
        return parts.joined(separator: "  ")
    }

    /// The callout's last line: "+3,12% since 1 sie". The percent form is
    /// preferred because it is narrower; the amount form is used only when
    /// there is no honest percent.
    static func scrubLine(
        _ change: ChartChange?,
        unit: ChartUnit,
        currency: String,
        since: String
    ) -> String? {
        guard let change else { return nil }
        let figure: String
        switch unit {
        case .money:
            if let percent = change.percent {
                figure = fmtPct(percent)
            } else {
                figure = signedMoney(change.absolute, currency: currency)
            }
        case .rate:
            if let percent = change.percent {
                figure = fmtPct(percent)
            } else {
                figure = signedRate(change.absolute)
            }
        case .percent:
            figure = points(change.absolute)
        }
        return "\(figure) since \(since)"
    }

    /// The same line for VoiceOver, which would otherwise spell "pp" as two
    /// letters.
    static func spoken(_ line: String) -> String {
        line.replacingOccurrences(of: nbsp + "pp", with: " percentage points")
    }
}
