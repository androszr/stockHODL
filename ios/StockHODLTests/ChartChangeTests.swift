import Foundation
import Testing

@testable import StockHODL

/// A plotted point with NO geometry — every coordinate is zero, so any
/// assertion below that depended on one would fail. The arithmetic must read
/// only `raw`.
private func plot(_ raw: String, t: Int = 0) -> PlotPoint {
    PlotPoint(index: 0, t: t, x: 0, y: 0, raw: raw, phase: nil, candle: nil)
}

/// Separators are escapes, never typed: pl-PL groups and gaps with U+00A0,
/// and a plain space pasted in its place is invisible in a diff.
@Suite("Chart change")
struct ChartChangeTests {
    private func d(_ string: String) -> Decimal {
        guard let value = dec(string) else {
            fatalError("test literal \(string) is not a decimal")
        }
        return value
    }

    // MARK: money

    @Test("money, up: amount, percent and the window, in that order")
    func moneyUp() throws {
        let change = try #require(ChartChanges.change(from: "100", to: "110", unit: .money))
        #expect(change.absolute == d("10"))
        #expect(change.percent == d("10"))
        #expect(
            ChartChanges.windowLine(change, unit: .money, currency: "PLN", windowLabel: "past month")
                == "+10,00\u{00A0}zł  +10,00%  past month"
        )
    }

    @Test("money, down: a leading minus on both figures")
    func moneyDown() throws {
        let change = try #require(ChartChanges.change(from: "110", to: "100", unit: .money))
        #expect(change.absolute == d("-10"))
        #expect(fmtPct(change.percent) == "-9,09%")
        let line = try #require(
            ChartChanges.windowLine(change, unit: .money, currency: "PLN", windowLabel: "past month")
        )
        #expect(line.hasPrefix("-10,00\u{00A0}zł"))
    }

    @Test("money, flat: no sign on either figure")
    func moneyFlat() throws {
        let change = try #require(ChartChanges.change(from: "100", to: "100", unit: .money))
        #expect(change.absolute == 0)
        #expect(change.percent == 0)
        #expect(
            ChartChanges.windowLine(change, unit: .money, currency: "PLN", windowLabel: "past month")
                == "0,00\u{00A0}zł  0,00%  past month"
        )
    }

    @Test("a zero baseline has an amount and no percent — never a fake 0,00%")
    func zeroBaseline() throws {
        let change = try #require(ChartChanges.change(from: "0", to: "50", unit: .money))
        #expect(change.absolute == d("50"))
        #expect(change.percent == nil)
        let line = ChartChanges.windowLine(change, unit: .money, currency: "PLN", windowLabel: "past month")
        #expect(line == "+50,00\u{00A0}zł  past month")
        #expect(line?.contains("—") == false)
    }

    @Test("a negative baseline refuses the percent too — the ratio would flip sign")
    func negativeBaseline() throws {
        let change = try #require(ChartChanges.change(from: "-50", to: "50", unit: .money))
        #expect(change.absolute == d("100"))
        #expect(change.percent == nil)
    }

    // MARK: percent (Return mode)

    @Test("percent unit is a percentage-point delta and never a percent of a percent")
    func percentagePoints() throws {
        let up = try #require(ChartChanges.change(from: "0", to: "3.12", unit: .percent))
        #expect(up.absolute == d("3.12"))
        #expect(up.percent == nil)
        #expect(
            ChartChanges.windowLine(up, unit: .percent, currency: "PLN", windowLabel: "past month")
                == "+3,12\u{00A0}pp  past month"
        )

        let down = try #require(ChartChanges.change(from: "5", to: "2", unit: .percent))
        #expect(down.percent == nil)
        let line = try #require(
            ChartChanges.windowLine(down, unit: .percent, currency: "PLN", windowLabel: "past month")
        )
        #expect(line.hasPrefix("-3,00\u{00A0}pp"))
        #expect(!line.contains("%"))
    }

    // MARK: rate (the USD/PLN market screen)

    @Test("rate, up: four decimals, signed, with the percent — and no currency")
    func rateUp() throws {
        let change = try #require(ChartChanges.change(from: "3.7500", to: "3.7955", unit: .rate))
        #expect(change.absolute == d("0.0455"))
        #expect(fmtPct(change.percent) == "+1,21%")
        #expect(
            ChartChanges.windowLine(change, unit: .rate, currency: "PLN", windowLabel: "today")
                == "+0,0455  +1,21%  today"
        )
        #expect(ChartChanges.signedRate(d("-0.0045")) == "-0,0045")
    }

    @Test("rate: the sign is decided after rounding to four digits")
    func rateSignAfterRounding() throws {
        // 0,00004 rounds to 0,0000 — printed unsigned and painted neutral,
        // exactly the money rule; colour must never say what the figure does not.
        let hair = try #require(ChartChanges.change(from: "3.75000", to: "3.75004", unit: .rate))
        #expect(ChartChanges.signedRate(hair.absolute) == "0,0000")
        #expect(ChartChanges.directionOf(hair, unit: .rate, currency: "PLN") == .neutral)

        let visible = try #require(ChartChanges.change(from: "3.7500", to: "3.7501", unit: .rate))
        #expect(ChartChanges.signedRate(visible.absolute) == "+0,0001")
        #expect(ChartChanges.directionOf(visible, unit: .rate, currency: "PLN") == .gain)
    }

    @Test("rate: a zero baseline refuses the percent, like money")
    func rateZeroBaseline() throws {
        let change = try #require(ChartChanges.change(from: "0", to: "3.75", unit: .rate))
        #expect(change.percent == nil)
        let line = try #require(
            ChartChanges.windowLine(change, unit: .rate, currency: "PLN", windowLabel: nil)
        )
        #expect(line == "+3,7500")
        #expect(!line.contains("%"))
    }

    @Test("rate: the scrub line prefers the percent and falls back to the four-digit delta")
    func rateScrubLine() throws {
        let change = try #require(ChartChanges.change(from: "3.7500", to: "3.7955", unit: .rate))
        #expect(
            ChartChanges.scrubLine(change, unit: .rate, currency: "PLN", since: "09:00")
                == "+1,21% since 09:00"
        )
        let noBase = try #require(ChartChanges.change(from: "0", to: "3.7955", unit: .rate))
        #expect(
            ChartChanges.scrubLine(noBase, unit: .rate, currency: "PLN", since: "09:00")
                == "+3,7955 since 09:00"
        )
    }

    @Test("rate: the OHLC line prints four digits and no currency")
    func rateOhlcLine() {
        let bar = PlotPoint.Candle(o: 3.7500, h: 3.7990, l: 3.7450)
        let line = ValueChart.ohlcLine(bar, unit: .rate, currency: "PLN")
        #expect(line == "O 3,7500 · H 3,7990 · L 3,7450")
        #expect(!line.contains("zł"))
    }

    // MARK: windows

    @Test("a single-point window has no change to report")
    func singlePoint() {
        #expect(ChartChanges.window([plot("100")], unit: .money) == nil)
        #expect(ChartChanges.windowLine(nil, unit: .money, currency: "PLN", windowLabel: "past month") == nil)
    }

    @Test("the window is last against first, never the drawn geometry")
    func windowIsFirstToLast() throws {
        let plotted = [plot("100", t: 1), plot("400", t: 2), plot("120", t: 3)]
        let change = try #require(ChartChanges.window(plotted, unit: .money))
        #expect(change.absolute == d("20"))
        #expect(change.percent == d("20"))
    }

    @Test("an unparsable baseline or an empty window yields nothing, not a zero")
    func unparsable() {
        #expect(ChartChanges.change(from: "abc", to: "1", unit: .money) == nil)
        #expect(ChartChanges.change(from: "1", to: "", unit: .percent) == nil)
        #expect(ChartChanges.sinceStart(of: plot("1"), in: [], unit: .money) == nil)
    }

    // MARK: scrubbing

    @Test("scrubbing the first point reads a flat zero, shown rather than hidden")
    func sinceStartAtFirstPoint() throws {
        let plotted = [plot("100", t: 1), plot("110", t: 2)]
        let change = try #require(ChartChanges.sinceStart(of: plotted[0], in: plotted, unit: .money))
        #expect(change.absolute == 0)
        #expect(
            ChartChanges.scrubLine(change, unit: .money, currency: "PLN", since: "1 sie")
                == "0,00% since 1 sie"
        )
    }

    @Test("the scrub line prefers the percent and falls back to the amount")
    func scrubLineForms() throws {
        let plotted = [plot("100", t: 1), plot("110", t: 2)]
        let up = try #require(ChartChanges.sinceStart(of: plotted[1], in: plotted, unit: .money))
        #expect(
            ChartChanges.scrubLine(up, unit: .money, currency: "PLN", since: "1 sie")
                == "+10,00% since 1 sie"
        )

        let fromZero = try #require(ChartChanges.change(from: "0", to: "50", unit: .money))
        #expect(
            ChartChanges.scrubLine(fromZero, unit: .money, currency: "PLN", since: "1 sie")
                == "+50,00\u{00A0}zł since 1 sie"
        )

        let points = try #require(ChartChanges.change(from: "0", to: "3.12", unit: .percent))
        #expect(
            ChartChanges.scrubLine(points, unit: .percent, currency: "USD", since: "1 sie")
                == "+3,12\u{00A0}pp since 1 sie"
        )
        #expect(ChartChanges.scrubLine(nil, unit: .money, currency: "PLN", since: "1 sie") == nil)
    }

    // MARK: formatters

    @Test("the sign is decided after rounding, so a hair above zero prints unsigned")
    func signAfterRounding() {
        #expect(ChartChanges.signedMoney(d("0.004"), currency: "PLN") == "0,00\u{00A0}zł")
        #expect(ChartChanges.signedMoney(d("-0.004"), currency: "PLN") == "0,00\u{00A0}zł")
        #expect(ChartChanges.points(d("0.004")) == "0,00\u{00A0}pp")
        #expect(ChartChanges.signedMoney(d("1234.5"), currency: "USD") == "+1\u{00A0}234,50\u{00A0}USD")
        #expect(ChartChanges.signedMoney(d("-0.01"), currency: "PLN") == "-0,01\u{00A0}zł")
    }

    @Test("the colour follows directionOf on the absolute change")
    func direction() throws {
        let up = try #require(ChartChanges.change(from: "100", to: "110", unit: .money))
        let down = try #require(ChartChanges.change(from: "110", to: "100", unit: .money))
        let flat = try #require(ChartChanges.change(from: "100", to: "100", unit: .money))
        #expect(directionOf(up.absolute) == .gain)
        #expect(directionOf(down.absolute) == .loss)
        #expect(directionOf(flat.absolute) == .neutral)
    }

    @Test("a change that rounds to zero is neutral, so colour never says what the figure does not")
    func directionFollowsRounding() throws {
        let hair = try #require(ChartChanges.change(from: "100", to: "100.004", unit: .money))
        let negativeHair = try #require(ChartChanges.change(from: "100.004", to: "100", unit: .money))
        let hairPoints = try #require(ChartChanges.change(from: "1", to: "1.004", unit: .percent))
        let cent = try #require(ChartChanges.change(from: "100", to: "100.01", unit: .money))
        let minusCent = try #require(ChartChanges.change(from: "100.01", to: "100", unit: .money))

        // The text prints "0,00 zł" with no sign — the tint must agree.
        #expect(ChartChanges.directionOf(hair, unit: .money, currency: "PLN") == .neutral)
        #expect(ChartChanges.directionOf(negativeHair, unit: .money, currency: "PLN") == .neutral)
        #expect(ChartChanges.directionOf(hairPoints, unit: .percent, currency: "PLN") == .neutral)
        // Anything that prints a digit keeps its direction.
        #expect(ChartChanges.directionOf(cent, unit: .money, currency: "PLN") == .gain)
        #expect(ChartChanges.directionOf(minusCent, unit: .money, currency: "PLN") == .loss)
    }

    @Test("VoiceOver hears percentage points, not two letters")
    func spoken() {
        #expect(ChartChanges.spoken("+3,12\u{00A0}pp  past month") == "+3,12 percentage points  past month")
        #expect(ChartChanges.spoken("+3,12% since 1 sie") == "+3,12% since 1 sie")
    }
}

/// The RULE is pinned against `ChartLabels`' own formatters rather than
/// literal Polish strings, so a CLDR update cannot fail this suite.
@Suite("Since label")
struct SinceLabelTests {
    private let day = 86_400_000
    // 2025-10-09 08:53:20 UTC — an arbitrary fixed instant.
    private let t = 1_760_000_000_000

    @Test("one intraday session reads as a clock time")
    func singleSession() {
        // 04:00–20:00 ET is sixteen hours; well under a day.
        #expect(ChartLabels.since(t, granularity: .intraday, spanMs: 16 * 3_600_000) == ChartLabels.hourMinute(t))
    }

    @Test("a multi-session intraday window reads as a day and month")
    func fiveDays() {
        #expect(ChartLabels.since(t, granularity: .intraday, spanMs: 4 * day + 16 * 3_600_000) == ChartLabels.dayMonth(t))
    }

    @Test("daily windows switch from day-month to month-year at the axis threshold")
    func dailyThreshold() {
        #expect(ChartLabels.since(t, granularity: .daily, spanMs: 370 * day) == ChartLabels.dayMonth(t))
        #expect(ChartLabels.since(t, granularity: .daily, spanMs: 370 * day + 1) == ChartLabels.monthYear(t))
        // The two forms really are different, or the assertions above prove nothing.
        #expect(ChartLabels.dayMonth(t) != ChartLabels.monthYear(t))
    }
}
