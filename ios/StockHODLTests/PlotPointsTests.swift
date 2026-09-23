import Foundation
import Testing

@testable import StockHODL

/// A chart point with as little ceremony as the generated contract allows.
private func point(t: Int, _ value: String, _ phase: SessionMarker? = nil) -> ChartPoint {
    ChartPoint(h: nil, l: nil, o: nil, p: phase, r: nil, t: t, v: value)
}

@Suite("Plot points")
struct PlotPointsTests {
    // MARK: - The sanctioned crossing

    @Test("a value that will not parse is dropped, never zeroed")
    func dropsUnparseable() {
        let plotted = PlotPoints.map(
            [point(t: 0, "10"), point(t: 1, "not a number"), point(t: 2, "12")],
            granularity: .intraday
        )

        // A fabricated zero would draw a cliff to the floor and read as a real
        // crash in price. A shorter line is the honest failure.
        #expect(plotted.map(\.raw) == ["10", "12"])
        // Indices renumber, so they still address this array.
        #expect(plotted.map(\.index) == [0, 1])
    }

    @Test("intraday plots by index, daily plots by timestamp scaled to days")
    func axisPlacement() {
        let points = [point(t: 1_760_000_000_000, "10"), point(t: 1_760_000_300_000, "11")]

        // Categorical: overnight and weekend gaps carry no bars, and a
        // continuous axis would draw them as a diagonal across half the chart.
        #expect(PlotPoints.map(points, granularity: .intraday).map(\.x) == [0, 1])
        // Days-since-epoch, not raw milliseconds: Swift Charts positions marks
        // in Float32, and the 13-digit millisecond magnitude loses enough
        // precision to collapse months-apart points onto the same pixel — the
        // reported "6M chart is a single vertical line" bug.
        #expect(PlotPoints.map(points, granularity: .daily).map(\.x) == [
            1_760_000_000_000 / 86_400_000, 1_760_000_300_000 / 86_400_000,
        ])
    }

    @Test("the decimal string survives the crossing untouched")
    func keepsTheString() throws {
        let plotted = PlotPoints.map([point(t: 0, "23708.1149")], granularity: .daily)
        let first = try #require(plotted.first)

        // The float is geometry; the string is what any label formats. If these
        // ever come apart, the chart starts lying in the tooltip.
        #expect(first.raw == "23708.1149")
        #expect(dec(first.raw) == Decimal(string: "23708.1149"))
    }

    // MARK: - Extended-hours bands (port of session-phase.test.ts)

    private func spans(_ phases: [SessionMarker?]) -> [PhaseSpan] {
        PlotPoints.spans(
            PlotPoints.map(
                phases.enumerated().map { point(t: $0.offset, "1", $0.element) },
                granularity: .intraday
            )
        )
    }

    @Test("each run extends one index into the neighbouring regular bar")
    func extendsIntoRegular() {
        let result = spans([.pre, .pre, nil, nil, .post, .post])

        // Without the extension a hairline of unshaded background sits between
        // the band and the session it borders.
        #expect(result.map(\.phase) == [.pre, .post])
        #expect(result.map(\.from) == [0, 3])
        #expect(result.map(\.to) == [2, 5])
    }

    @Test("a run touching either end stays inside the domain")
    func staysInDomain() {
        #expect(spans([.pre]).map { ($0.from, $0.to) }.map(\.0) == [0])
        #expect(spans([.pre]).map(\.to) == [0])
        #expect(spans([.post]).map(\.from) == [0])
        #expect(spans([.post]).map(\.to) == [0])
    }

    @Test("an untagged series shades nothing — every daily range")
    func untaggedShadesNothing() {
        #expect(spans([nil, nil]).isEmpty)
        #expect(PlotPoints.spans([]).isEmpty)
    }

    // MARK: - Axis precision

    @Test("axis digits follow the spread, not the magnitude")
    func axisDigits() {
        // A 23 USD stock moving a złoty: without cents the labels collapse into
        // three identical whole numbers.
        let tight = PlotPoints.map([point(t: 0, "23.10"), point(t: 1, "23.90")], granularity: .daily)
        #expect(PlotPoints.axisFractionDigits(tight) == 2)

        // A portfolio swinging thousands: cents are noise.
        let wide = PlotPoints.map([point(t: 0, "16000"), point(t: 1, "23708")], granularity: .daily)
        #expect(PlotPoints.axisFractionDigits(wide) == 0)
    }

    // MARK: - The Y window

    @Test("the peak never sits on the top edge")
    func peakHasHeadroom() {
        // The reported shape: a line that climbs to its high at the very end,
        // which Swift Charts' default domain draws with half the stroke
        // clipped by the frame.
        let rising = PlotPoints.map(
            [point(t: 0, "1000"), point(t: 1, "1100"), point(t: 2, "1200")],
            granularity: .daily
        )
        let domain = PlotPoints.yDomain(rising)

        #expect(domain.upperBound > 1200)
        #expect(domain.lowerBound < 1000)
        // More room above than below: the scrub callout floats at the top of
        // the plot, and a recent peak would otherwise sit underneath it.
        #expect(domain.upperBound - 1200 > 1000 - domain.lowerBound)
    }

    @Test("a flat series still gets a window it can be drawn in")
    func flatSeries() {
        let flat = PlotPoints.map(
            [point(t: 0, "42.50"), point(t: 1, "42.50")],
            granularity: .daily
        )
        let domain = PlotPoints.yDomain(flat)

        // Zero spread means a fraction of the spread is also zero, which would
        // collapse the domain to a point and put the line back on an edge.
        #expect(domain.lowerBound < 42.5)
        #expect(domain.upperBound > 42.5)
    }

    @Test("a series that never went negative gets no negative floor")
    func noInventedDebt() {
        // A portfolio worth 40 zł at its low: 6% below is still positive, but
        // a small enough low would push the floor under zero and print a tick
        // describing a debt that never existed.
        let nearZero = PlotPoints.map(
            [point(t: 0, "0.10"), point(t: 1, "8.00")],
            granularity: .daily
        )

        #expect(PlotPoints.yDomain(nearZero).lowerBound >= 0)
    }

    @Test("the X window is the plotted extent, not a frame anchored at zero")
    func xDomainIsTheData() {
        // The regression this exists for: a daily X is days-since-epoch
        // (~20 700 today), and Swift Charts' automatic numeric domain starts
        // at ZERO. Six months of bars then live in the last 1% of the plot —
        // the "vertical smear at the right edge" the chart used to draw.
        let sixMonths = PlotPoints.map(
            (0..<126).map { point(t: 1_771_545_600_000 + $0 * 86_400_000, "100") },
            granularity: .daily
        )
        let domain = PlotPoints.xDomain(sixMonths)

        #expect(domain.lowerBound == sixMonths[0].x)
        #expect(domain.upperBound == sixMonths[sixMonths.count - 1].x)
        // The span is the window itself — 125 days between first and last —
        // not a fraction of a percent of a 56-year frame.
        #expect(domain.upperBound - domain.lowerBound == 125)
    }

    @Test("a single-X series still yields a domain that can be scaled into")
    func xDomainDegenerate() {
        let sameDay = PlotPoints.map(
            [point(t: 1_771_545_600_000, "100"), point(t: 1_771_545_600_000, "101")],
            granularity: .daily
        )

        #expect(PlotPoints.xDomain(sameDay).upperBound > PlotPoints.xDomain(sameDay).lowerBound)
        #expect(PlotPoints.xDomain([]).upperBound > PlotPoints.xDomain([]).lowerBound)
    }

    @Test("rangeFraction places an interior value between the ends")
    func rangeFractionInterior() {
        #expect(PlotPoints.rangeFraction(low: "100", high: "200", value: "150") == 0.5)
    }

    @Test("rangeFraction clamps below low to 0 and above high to 1")
    func rangeFractionClamps() {
        #expect(PlotPoints.rangeFraction(low: "100", high: "200", value: "50") == 0)
        #expect(PlotPoints.rangeFraction(low: "100", high: "200", value: "250") == 1)
    }

    @Test("rangeFraction is nil when the span is degenerate or unparseable")
    func rangeFractionNil() {
        #expect(PlotPoints.rangeFraction(low: "100", high: "100", value: "100") == nil)
        #expect(PlotPoints.rangeFraction(low: "not", high: "200", value: "150") == nil)
    }

    @Test("an empty series still yields a usable range")
    func emptyDomain() {
        // Never called with one today — the chart requires two points before
        // it draws — but a ClosedRange built from a nil min would crash, and
        // this file is the one place that arithmetic lives.
        #expect(PlotPoints.yDomain([]).upperBound > PlotPoints.yDomain([]).lowerBound)
    }

    // MARK: - Ticks

    /// 2026-08-12 is a plain Wednesday in EDT (UTC−4).
    private func at(_ utc: String) -> Int {
        let formatter = ISO8601DateFormatter()
        let date = formatter.date(from: "2026-08-12T\(utc):00Z")!
        return Int(date.timeIntervalSince1970 * 1000)
    }

    @Test("one session ticks by the hour; several tick by the day")
    func tickUnit() {
        let oneSession = PlotPoints.map(
            [at("14:00"), at("14:30"), at("15:00")].map { point(t: $0, "1") },
            granularity: .intraday
        )
        // Two clock hours in the window → two ticks, not three.
        #expect(PlotPoints.intradayTicks(oneSession).count == 2)

        let twoSessions = PlotPoints.map(
            [at("14:00"), at("15:00"), at("14:00") + 86_400_000].map { point(t: $0, "1") },
            granularity: .intraday
        )
        #expect(PlotPoints.intradayTicks(twoSessions).count == 2)
    }

    @Test("an extended-hours session thins its hour ticks so the labels are not truncated")
    func extendedHoursTicksAreThinned() {
        // Pre-market through after-hours: 08:00 to 23:30 UTC, sixteen hour
        // starts. Drawn one per hour they collide and Swift Charts truncates
        // every label to `1…`; every second one is kept instead.
        let extended = PlotPoints.map(
            (0..<32).map { point(t: at("08:00") + $0 * 1_800_000, "1") },
            granularity: .intraday
        )
        let ticks = PlotPoints.intradayTicks(extended)
        #expect(ticks.count == 8)
        #expect(ticks.count <= PlotPoints.maxHourTicks)
        // Ticks still sit on real hour starts, the first one included.
        #expect(ticks.first?.x == extended.first?.x)
        #expect(ticks.map(\.label).allSatisfy { $0.hasSuffix(":00") })

        // A regular session's eight hour starts are not thinned at all.
        let regular = PlotPoints.map(
            (0..<14).map { point(t: at("13:30") + $0 * 1_800_000, "1") },
            granularity: .intraday
        )
        #expect(PlotPoints.intradayTicks(regular).count == 8)
    }

    @Test("a session boundary is the NY calendar day, not the phone's")
    func sessionBoundaryIsNewYork() {
        // 23:00 and 23:30 UTC are 19:00 and 19:30 ET — the same NY session, and
        // the same after-hours run. In Warsaw they are already tomorrow, and a
        // device-local boundary would split the session in two.
        let sameSession = PlotPoints.map(
            [at("23:00"), at("23:30")].map { point(t: $0, "1") },
            granularity: .intraday
        )
        #expect(PlotPoints.intradayTicks(sameSession).count == 1)
    }

    @Test("daily ticks land on real observations and stay within the series")
    func dailyTicks() {
        let points = PlotPoints.map(
            (0..<30).map { point(t: $0 * 86_400_000, "\(100 + $0)") },
            granularity: .daily
        )
        let ticks = PlotPoints.dailyTicks(points)

        #expect(!ticks.isEmpty)
        // Every tick sits on a plotted point: five ticks at equal TIME offsets
        // would land in weekend gaps where nothing was ever observed.
        let placed = Set(points.map(\.x))
        #expect(ticks.allSatisfy { placed.contains($0.x) })
    }

    @Test("a series too short to be a line has no ticks and no bands")
    func degenerate() {
        let single = PlotPoints.map([point(t: 0, "10")], granularity: .daily)
        #expect(PlotPoints.dailyTicks(single).isEmpty)
        #expect(PlotPoints.axisFractionDigits(single) == 2)
    }
}

@Suite("Chart range")
struct ChartRangeTests {
    @Test("the eight ranges are the server's eight, spelled its way")
    func rawValues() {
        // These strings ARE the wire. A typo is a 400, not a fallback.
        #expect(ChartRange.allCases.map(\.rawValue) == [
            "1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "ALL",
        ])
    }

    @Test("only 1D and 5D draw a categorical axis")
    func granularity() {
        let intraday = ChartRange.allCases.filter { $0.granularity == .intraday }
        #expect(intraday == [.oneDay, .fiveDay])
    }

    @Test("an unknown remembered value falls back rather than crashing")
    func fallback() {
        // A range dropped from the enum between two builds is exactly the case
        // that must not brick the chart on launch.
        #expect(ChartRange(rawValue: "3Y") == nil)
        #expect(ChartRange.fallback == .oneDay)
    }
}

// MARK: - Modes and candles

@Suite("Plot modes")
struct PlotModeTests {
    private func point(t: Int, v: String, r: String? = nil) -> ChartPoint {
        ChartPoint(h: nil, l: nil, o: nil, p: nil, r: r, t: t, v: v)
    }

    private func bar(t: Int, o: String, h: String, l: String, v: String) -> ChartPoint {
        ChartPoint(h: h, l: l, o: o, p: nil, r: nil, t: t, v: v)
    }

    @Test("value mode plots `v`, return mode plots `r`")
    func picksTheRightField() {
        let points = [
            point(t: 1, v: "1000.00", r: "0.00"),
            point(t: 2, v: "1100.00", r: "10.00"),
        ]

        #expect(PlotPoints.map(points, granularity: .daily).map(\.raw) == ["1000.00", "1100.00"])
        #expect(
            PlotPoints.map(points, granularity: .daily, mode: .percentReturn).map(\.raw)
                == ["0.00", "10.00"]
        )
    }

    @Test("a point with no return is dropped, never zeroed")
    func dropsPointsWithoutAReturn() {
        let points = [
            point(t: 1, v: "1000.00"),
            point(t: 2, v: "1100.00", r: "10.00"),
        ]

        // A portfolio with no cost basis that day has no return, and drawing
        // 0 % would claim it broke even.
        let plotted = PlotPoints.map(points, granularity: .daily, mode: .percentReturn)
        #expect(plotted.count == 1)
        #expect(plotted[0].raw == "10.00")
        // The index is reassigned after the drop, so it still matches the array.
        #expect(plotted[0].index == 0)
    }

    @Test("all three of o/h/l or no candle at all")
    func candlesAreAllOrNothing() {
        let complete = bar(t: 1, o: "10", h: "12", l: "9", v: "11")
        let partial = ChartPoint(h: "12", l: nil, o: "10", p: nil, r: nil, t: 2, v: "11")

        let plotted = PlotPoints.map([complete, partial], granularity: .daily)
        #expect(plotted[0].candle != nil)
        // A partial bar is a bug upstream, not something to render half of.
        #expect(plotted[1].candle == nil)
        // The close line still spans it — that is the honest "no bar here".
        #expect(plotted[1].y == 11)
        #expect(PlotPoints.hasCandles(plotted))
    }

    @Test("return mode never carries a candle")
    func noCandlesOnAPercentAxis() {
        let points = [bar(t: 1, o: "10", h: "12", l: "9", v: "11")]
        let plotted = PlotPoints.map(points, granularity: .daily, mode: .percentReturn)
        // The one point has no `r`, so it drops — which is itself the check
        // that a price bar cannot sneak onto a percent axis.
        #expect(plotted.isEmpty)

        let withReturn = [
            ChartPoint(h: "12", l: "9", o: "10", p: nil, r: "5.00", t: 1, v: "11"),
        ]
        // Three PRICES drawn against a percentage would be nonsense.
        #expect(PlotPoints.map(withReturn, granularity: .daily, mode: .percentReturn)[0].candle == nil)
    }

    @Test("a range with no bars reports no candles, so the view can fall back")
    func hasCandlesIsFalseForACloseOnlySeries() {
        let plotted = PlotPoints.map(
            [point(t: 1, v: "10"), point(t: 2, v: "11")],
            granularity: .intraday
        )
        // An intraday range stores closes only. A Candles tab producing an
        // empty frame would look broken rather than honest.
        #expect(!PlotPoints.hasCandles(plotted))
    }

    @Test("the Y window fits the WICKS, not just the closes")
    func domainCoversTheWicks() {
        let plotted = PlotPoints.map(
            [
                bar(t: 1, o: "100", h: "140", l: "60", v: "110"),
                bar(t: 2, o: "110", h: "130", l: "70", v: "120"),
            ],
            granularity: .daily
        )

        let domain = PlotPoints.yDomain(plotted)
        // Fitted to the closes (110–120) the highest wick at 140 would be
        // clipped — in the one view that was switched on to see it.
        #expect(domain.upperBound > 140)
        #expect(domain.lowerBound < 60)
    }
}
