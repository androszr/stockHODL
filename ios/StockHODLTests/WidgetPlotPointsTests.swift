import CoreGraphics
import Foundation
import Testing

@testable import StockHODL

/// Plot geometry, not money: `Decimal` → `NSDecimalNumber.doubleValue` may land
/// one unit in the last place from the nearest double, which no pixel shows.
private func close(_ actual: Double?, _ expected: Double) -> Bool {
    guard let actual else { return false }
    return abs(actual - expected) < 1e-9
}

@Suite("Widget plot points")
struct WidgetPlotPointsTests {
    private let size = CGSize(width: 100, height: 100)

    @Test("a value that will not parse is dropped, never zeroed")
    func dropsUnparseable() {
        let lines = WidgetDayLines(
            holdings: [
                WidgetDayPoint(p: "-1.43", t: 0),
                WidgetDayPoint(p: "nope", t: 50),
                WidgetDayPoint(p: "-1.20", t: 100),
            ],
            options: [],
            sessionCloseMs: 100,
            sessionOpenMs: 0
        )
        let mapped = WidgetPlotPoints.map(lines, in: size)
        let values = mapped.holdings.map(\.value)
        #expect(values.count == 2)
        #expect(close(values.first, -1.43))
        #expect(close(values.last, -1.20))
    }

    /// The parse goes through `Decimal`, whose string initialiser alone would
    /// read the longest valid PREFIX. A percent that is not wholly a number
    /// must still be dropped, and every shape the server writes must parse.
    @Test("parses plain decimals strictly: a numeric prefix is not a number")
    func strictParse() {
        #expect(close(WidgetPlotPoints.plotValue("-1.43"), -1.43))
        #expect(close(WidgetPlotPoints.plotValue("+2.5"), 2.5))
        #expect(close(WidgetPlotPoints.plotValue(".5"), 0.5))
        // The one use of the value beyond position is its SIGN (the colour
        // split at zero), so zero and the sign are exact, not approximate.
        #expect(WidgetPlotPoints.plotValue("0") == 0)
        #expect(WidgetPlotPoints.plotValue("-0.01").map { $0 < 0 } == true)
        #expect(WidgetPlotPoints.plotValue("0.01").map { $0 > 0 } == true)
        for garbage in ["1.5abc", "1,5", "", " 1.5", "1.5 ", "1e3", "nan", "--1", "."] {
            #expect(WidgetPlotPoints.plotValue(garbage) == nil, "\(garbage)")
        }
    }

    @Test("session-clock X: open is 0, close is the width, 42 percent is 42")
    func sessionClock() {
        let lines = WidgetDayLines(
            holdings: [WidgetDayPoint(p: "-1.43", t: 42)],
            options: [
                WidgetDayPoint(p: "-8.92", t: 0),
                WidgetDayPoint(p: "-8.92", t: 100),
            ],
            sessionCloseMs: 100,
            sessionOpenMs: 0
        )
        let mapped = WidgetPlotPoints.map(lines, in: size)
        #expect(mapped.options.first?.x == 0)
        #expect(mapped.options.last?.x == 100)
        #expect(mapped.holdings.first?.x == 42)
    }

    @Test("shared cap is the larger move, not a 3 percent lights ceiling")
    func fittedCapNotLights() {
        let lines = WidgetDayLines(
            holdings: [
                WidgetDayPoint(p: "-1.43", t: 0),
                WidgetDayPoint(p: "-1.43", t: 100),
            ],
            options: [
                WidgetDayPoint(p: "-8.92", t: 0),
                WidgetDayPoint(p: "-8.92", t: 100),
            ],
            sessionCloseMs: 100,
            sessionOpenMs: 0
        )
        let mapped = WidgetPlotPoints.map(lines, in: size)
        let hold = abs(mapped.holdings[0].y - mapped.zeroY)
        let opt = abs(mapped.options[0].y - mapped.zeroY)
        #expect(opt > hold)
        // A 3% cap would pin −8.92 to the same floor as −3; −1.43 would then
        // sit much closer to that floor. Fitted, −1.43 stays a shallow cut.
        #expect(hold < opt / 2)
    }

    @Test("an empty or all-zero series draws nothing")
    func emptyOrFlatDrawsNothing() {
        let empty = WidgetPlotPoints.map(
            WidgetDayLines(holdings: [], options: [], sessionCloseMs: 100, sessionOpenMs: 0),
            in: size
        )
        #expect(empty.holdings.isEmpty)
        #expect(empty.options.isEmpty)

        let flat = WidgetPlotPoints.map(
            WidgetDayLines(
                holdings: [WidgetDayPoint(p: "0", t: 0), WidgetDayPoint(p: "0", t: 100)],
                options: [],
                sessionCloseMs: 100,
                sessionOpenMs: 0
            ),
            in: size
        )
        #expect(flat.holdings.isEmpty)
        #expect(flat.options.isEmpty)
    }
}
