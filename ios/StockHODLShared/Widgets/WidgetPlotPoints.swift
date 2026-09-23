import CoreGraphics
import Foundation

/// The widget's money→float crossing, geometry only.
///
/// Each percent string is parsed STRICTLY into `Decimal` (a plain signed
/// decimal, POSIX), and only then turned into a float through
/// `NSDecimalNumber.doubleValue` — the same direction the app's chart takes,
/// money into geometry and never back. The floats become coordinates and
/// nothing else: never formatted, never subtracted, never fed back into a
/// figure the user reads. Unparseable percents are DROPPED, never zeroed.
enum WidgetPlotPoints {
    struct Point: Sendable {
        var x: CGFloat
        var y: CGFloat
        /// Signed percent, geometry only — used to split colour at zero.
        var value: Double
    }

    struct Mapped: Sendable {
        var holdings: [Point]
        var options: [Point]
        var zeroY: CGFloat
    }

    /// Session-clock X (open → 0, close → 1) and a shared Y cap across both
    /// series. A degenerate cap (all zeros / nothing parseable) draws nothing.
    static func map(_ lines: WidgetDayLines, in size: CGSize) -> Mapped {
        let empty = Mapped(holdings: [], options: [], zeroY: size.height / 2)
        let span = lines.sessionCloseMs - lines.sessionOpenMs
        guard span > 0, size.width > 0, size.height > 0 else { return empty }

        let holdingsValues = parsed(lines.holdings)
        let optionsValues = parsed(lines.options)
        var cap = 0.0
        for pair in holdingsValues + optionsValues {
            cap = max(cap, abs(pair.value))
        }
        guard cap > 0 else { return empty }

        let inset: CGFloat = 1.5
        let usable = max(size.height - inset * 2, 0)

        func point(t: Int, value: Double) -> Point {
            // Session-clock time, not money: the fraction is computed in
            // CGFloat, the unit it is drawn in.
            let fraction = CGFloat(t - lines.sessionOpenMs) / CGFloat(span)
            let x = size.width * min(max(fraction, 0), 1)
            let yFraction = (value + cap) / (2 * cap)
            let y = inset + usable * (1 - CGFloat(yFraction))
            return Point(x: x, y: y, value: value)
        }

        let holdings = holdingsValues.map { point(t: $0.t, value: $0.value) }
        let options = optionsValues.map { point(t: $0.t, value: $0.value) }
        let zero = point(t: lines.sessionOpenMs, value: 0).y
        return Mapped(holdings: holdings, options: options, zeroY: zero)
    }

    private static func parsed(_ points: [WidgetDayPoint]) -> [(t: Int, value: Double)] {
        var out: [(t: Int, value: Double)] = []
        out.reserveCapacity(points.count)
        for point in points {
            guard let value = plotValue(point.p) else { continue }
            out.append((point.t, value))
        }
        return out
    }

    /// A plain signed decimal only — `-1.15`, `0`, `+2.5`, `.5`. The pattern
    /// check comes first because `Decimal(string:)` alone parses the longest
    /// valid PREFIX (`1.5abc` would read as 1.5); a string that is not wholly
    /// a number is dropped, exactly as before.
    static func plotValue(_ text: String) -> Double? {
        guard text.wholeMatch(of: /[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/) != nil,
              let decimal = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
        else { return nil }
        return NSDecimalNumber(decimal: decimal).doubleValue
    }
}
