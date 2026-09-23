import Foundation

/// **The one sanctioned money→float crossing in the iOS client.**
///
/// CI greps `ios/StockHODL` for `Double(` and allows exactly this file by name
/// (`.github/workflows/ci.yml`). That is the whole arrangement: Swift Charts
/// plots `Double`, so somewhere a decimal string has to become one, and the
/// answer to "where" must be a single file rather than a habit.
///
/// The doctrine is the same as `toPlotPoints` in `src/lib/charts/series.ts`:
/// **the floats become coordinates and nothing else.** They are never
/// formatted, never subtracted, never fed back into arithmetic a user reads.
/// Every visible figure — the axis, the scrubber, the header — is formatted
/// from the decimal STRING that rides along on each point, through
/// `Money.swift`. Float rysuje piksele, Decimal rysuje liczby.

/// One plotted point: geometry, plus everything a label needs.
struct PlotPoint: Identifiable, Sendable {
    /// Position on the categorical axis — the index AFTER unplottable points
    /// are dropped, so it always matches this array.
    let index: Int
    /// The real instant, epoch ms. Labels always format this, never the axis
    /// position, which for an intraday chart carries no time meaning at all.
    let t: Int
    /// Where the point sits on X: the index for a categorical intraday axis,
    /// the timestamp for a continuous daily one.
    let x: Double
    /// GEOMETRY ONLY.
    let y: Double
    /// The decimal string this point came from. The only thing ever displayed.
    let raw: String
    /// Extended-hours tag, as the SERVER classified it. Absent = regular
    /// session, and absent on every daily range.
    let phase: SessionMarker?
    /// GEOMETRY ONLY, and nil unless the stored bar carried all three of
    /// `o`/`h`/`l`. A point without one draws no candle — the continuity line
    /// still spans it, which is the honest rendering of "no bar here" and the
    /// same rule `toCandlePoints` applies on the web.
    let candle: Candle?

    var id: Int { index }

    /// One bar's open, high and low as coordinates. Close is `y`, which every
    /// point already has — a candle is the line chart plus three numbers.
    struct Candle: Sendable, Equatable {
        let o: Double
        let h: Double
        let l: Double
    }
}

/// One shaded extended-hours band, as inclusive X bounds on the plotted axis.
struct PhaseSpan: Identifiable, Sendable {
    let phase: SessionMarker
    let from: Double
    let to: Double

    var id: String { "\(phase.rawValue)-\(from)" }
}

enum PlotPoints {
    /// Decimal strings → plottable points.
    ///
    /// A value that will not parse is DROPPED, not zeroed. A fabricated zero
    /// would draw a cliff to the floor and read as a real crash in price; a
    /// missing point just shortens the line. `Double(_: String)` is
    /// locale-independent, unlike `Decimal(string:)` — the "." in "110.25" is
    /// always a decimal point here, which is exactly why `dec()` has to pin
    /// POSIX and this does not.
    static func map(
        _ points: [ChartPoint],
        granularity: ChartRange.Granularity,
        mode: ChartMode = .value
    ) -> [PlotPoint] {
        var plotted: [PlotPoint] = []
        plotted.reserveCapacity(points.count)

        for point in points {
            // In `.percentReturn` the plotted quantity is `r`, the server's
            // simple return against the open cost basis. A point WITHOUT one
            // is dropped for the same reason an unparsable `v` is: a portfolio
            // with no cost basis that day has no return, and drawing 0 % would
            // claim it broke even.
            let source = mode == .percentReturn ? point.r : point.v
            guard let source, let y = Double(source) else { continue }
            let index = plotted.count
            plotted.append(
                PlotPoint(
                    index: index,
                    t: point.t,
                    // Days-since-epoch, not raw epoch MILLISECONDS. Same
                    // continuous, gap-preserving axis (the reason `daily` is
                    // not index-based — see the test), five digits instead of
                    // thirteen, which keeps the axis arithmetic away from the
                    // precision floor of the Float32 the renderer positions
                    // marks in.
                    //
                    // On its own this fixes NOTHING visible: the 6-month range
                    // that collapsed into a smear at the right edge did so
                    // because the X domain was left automatic and Swift Charts
                    // anchors an automatic numeric domain at ZERO — 13 digits
                    // or 5, the window is a rounding error next to 1970. The
                    // cure is `xDomain`, stated explicitly on the chart.
                    x: granularity == .intraday ? Double(index) : Double(point.t) / 86_400_000,
                    y: y,
                    raw: source,
                    phase: point.p,
                    // Candles describe a PRICE bar. In return mode the axis is
                    // a percentage and an OHLC drawn against it would be three
                    // prices on a percent scale — nonsense, so never carried.
                    candle: mode == .value ? candle(of: point) : nil
                )
            )
        }
        return plotted
    }

    /// A bar's three extra coordinates, or nil.
    ///
    /// All three or none, matching the contract: `o`/`h`/`l` are documented as
    /// travelling together, and a partial bar is a bug upstream rather than
    /// something to render half of.
    private static func candle(of point: ChartPoint) -> PlotPoint.Candle? {
        guard let o = point.o, let h = point.h, let l = point.l,
              let open = Double(o), let high = Double(h), let low = Double(l)
        else { return nil }
        return PlotPoint.Candle(o: open, h: high, l: low)
    }

    /// Does this series have enough bars to draw candles at all?
    ///
    /// The toggle is display-only WHERE THE DATA ALLOWS — an intraday range
    /// stores closes only, and a Candles tab that produced an empty frame
    /// would look broken rather than honest. The caller falls back to the line.
    static func hasCandles(_ plotted: [PlotPoint]) -> Bool {
        plotted.contains { $0.candle != nil }
    }

    /// Contiguous runs of same-phase points → band bounds. Originally a port of
    /// the web chart's TypeScript helper (retired 2026-09-23; this is now the
    /// only implementation), including its off-by-one: each run
    /// is extended one point into the neighbouring REGULAR bar so the band edge
    /// lands on the open/close bar rather than half a bar short, which would
    /// leave a hairline of unshaded background against the session it borders.
    static func spans(_ points: [PlotPoint]) -> [PhaseSpan] {
        var spans: [PhaseSpan] = []
        var i = 0

        while i < points.count {
            guard let phase = points[i].phase else {
                i += 1
                continue
            }

            var end = i
            while end + 1 < points.count, points[end + 1].phase == phase { end += 1 }

            let fromIndex = phase == .post && i > 0 ? i - 1 : i
            let toIndex = phase == .pre && end + 1 < points.count ? end + 1 : end
            spans.append(PhaseSpan(phase: phase, from: points[fromIndex].x, to: points[toIndex].x))

            i = end + 1
        }
        return spans
    }

    /// Y-axis precision, following the visible SPREAD rather than the
    /// magnitude. Cents are noise across a 16 000 zł swing, but a 23 USD stock
    /// moving a złoty would collapse into three identical whole-unit labels
    /// without them. Same rule as `axisFractionDigits` on the web.
    ///
    /// The subtraction here is on already-plotted geometry, not on money: it
    /// decides how many digits to print, never what they are.
    static func axisFractionDigits(_ points: [PlotPoint]) -> Int {
        guard points.count >= 2 else { return 2 }
        let values = points.map(\.y)
        guard let low = values.min(), let high = values.max() else { return 2 }
        return (high - low) >= 10 ? 0 : 2
    }

    /// Headroom above and below the series, as fractions of the visible spread.
    ///
    /// Asymmetric on purpose: the scrub callout floats at the TOP of the plot,
    /// so a peak in the last few sessions would sit under it without the
    /// larger share up there.
    private static let headroom = (top: 0.10, bottom: 0.06)

    /// The Y window the chart draws in.
    ///
    /// Swift Charts defaults to the exact data extent, which puts the highest
    /// observation ON the top edge — half the stroke clipped by the frame, and
    /// a chart whose peak is recent reads as a line that ran out of room
    /// rather than out of data. `value-chart.tsx` never had this and never
    /// needed this code: recharts' `domain={['auto', 'auto']}` rounds outward
    /// to nice tick values, which is padding under another name. Swift Charts
    /// rounds its TICKS outward but not its DOMAIN, so the padding has to be
    /// asked for.
    ///
    /// Geometry, like everything else in this file. It decides where the frame
    /// sits, never what any label says — the labels are still formatted from
    /// the decimal strings the points carry.
    /// The X window: exactly the plotted extent, no padding.
    ///
    /// Swift Charts' automatic numeric X domain is anchored at ZERO, and a
    /// daily axis is days-since-epoch — around 20 700 today. Left automatic, a
    /// six-month window (181 wide) was drawn inside a 0…20 700 frame, which is
    /// the whole series squeezed into the last 1 % of the plot: the "vertical
    /// smear at the right edge" that the epoch-milliseconds theory blamed on
    /// Float32 and did not actually fix (raw `t` merely made the same zero
    /// anchor 13 digits wide instead of 5).
    ///
    /// Intraday is index-based and starts at 0 anyway, so the same explicit
    /// domain leaves it exactly where it already was — one rule, both axes.
    ///
    /// A degenerate span (every point on the same X — one calendar day of
    /// daily bars) is widened by half a unit either side, because a
    /// zero-width domain is not a domain Swift Charts can scale into.
    static func xDomain(_ points: [PlotPoint]) -> ClosedRange<Double> {
        let xs = points.map(\.x)
        guard let low = xs.min(), let high = xs.max() else { return 0...1 }
        return low < high ? low...high : (low - 0.5)...(high + 0.5)
    }

    /// Where `value` sits between `low` and `high`, as a 0...1 fraction.
    ///
    /// Geometry for the 52-week range bar: parse the three raw decimal
    /// strings, refuse a degenerate span (`high <= low`) or an unparseable
    /// input, clamp an out-of-range current to the ends. The `Double` is
    /// a coordinate and nothing else — never formatted, never subtracted
    /// as money.
    static func rangeFraction(low: String, high: String, value: String) -> Double? {
        guard let lo = dec(low), let hi = dec(high), let current = dec(value), hi > lo else {
            return nil
        }
        let fraction = NSDecimalNumber(decimal: (current - lo) / (hi - lo)).doubleValue
        if fraction < 0 { return 0 }
        if fraction > 1 { return 1 }
        return fraction
    }

    static func yDomain(_ points: [PlotPoint]) -> ClosedRange<Double> {
        // The WICKS, not just the closes: in candle mode the extremes of the
        // window are highs and lows that the close line never reaches, and a
        // domain fitted to the closes would clip the very bars the view was
        // switched to in order to see.
        var values = points.map(\.y)
        for point in points {
            guard let candle = point.candle else { continue }
            values.append(candle.h)
            values.append(candle.l)
        }
        guard let low = values.min(), let high = values.max() else { return 0...1 }

        let spread = high - low
        // A FLAT series has no spread to take a fraction of. Padding by a
        // fraction of the level instead lands the line mid-frame; without it
        // the domain collapses to a single point and Swift Charts draws the
        // line along an edge — the exact failure this function exists to
        // prevent, in the one case a spread-based rule cannot see.
        let unit = spread > 0 ? spread : max(abs(high) * 0.02, 0.01)
        let bottom = low - unit * headroom.bottom
        // A series that never went negative must not put a negative tick under
        // itself: on a portfolio-value chart that label is not just ugly, it
        // describes a debt that never existed.
        return (low >= 0 ? max(0, bottom) : bottom)...(high + unit * headroom.top)
    }
}

// MARK: - Axis ticks

/// Where the ticks go and what they say.
struct ChartTick: Identifiable, Sendable {
    let x: Double
    let label: String

    var id: Double { x }
}

extension PlotPoints {
    /// Tick positions for the CATEGORICAL intraday axis — port of
    /// `intradayAxisTicks`.
    ///
    /// Placement has to come from the DATA, not from the axis: positions carry
    /// no time meaning once sessions are glued together. Session starts across
    /// a multi-day window, hour starts within a single session. Labels always
    /// format the point's real `t`.
    ///
    /// Hour starts are THINNED to at most `maxHourTicks`: Swift Charts does
    /// not drop colliding labels on an explicit `values:` axis, it truncates
    /// each one, and a session drawn with its pre-market and after-hours
    /// (the day report's value line, 10:00 to 02:00 Warsaw, sixteen hour
    /// starts on a phone-wide plot) read as a row of `1…`. Every step-th hour
    /// start from the first is kept, step being the smallest whole number of
    /// hours that fits; a regular session's eight hour starts are untouched.
    static let maxHourTicks = 8

    static func intradayTicks(_ points: [PlotPoint], maxHourTicks: Int = maxHourTicks) -> [ChartTick] {
        var sessionStarts: [Int] = []
        var previousDate: String?
        for point in points {
            let date = NYCalendar.isoDate(atEpochMs: point.t)
            if date != previousDate {
                sessionStarts.append(point.index)
                previousDate = date
            }
        }

        if sessionStarts.count > 1 {
            return sessionStarts.map {
                ChartTick(x: points[$0].x, label: ChartLabels.dayMonth(points[$0].t))
            }
        }

        var hourStarts: [Int] = []
        var previousHour: Int?
        for point in points {
            // Whole-hour epoch boundaries coincide with wall-clock hour changes
            // in every whole-hour-offset zone, and both NY and Warsaw are one.
            // A count, not money.
            let hour = point.t / 3_600_000
            if hour != previousHour {
                hourStarts.append(point.index)
                previousHour = hour
            }
        }
        let perTick = max(1, maxHourTicks)
        let step = max(1, (hourStarts.count + perTick - 1) / perTick)
        return hourStarts.enumerated()
            .filter { $0.offset % step == 0 }
            .map { ChartTick(x: points[$0.element].x, label: ChartLabels.hourMinute(points[$0.element].t)) }
    }

    /// Ticks for the continuous daily axis.
    ///
    /// Evenly spaced by INDEX rather than by time, which is the honest choice
    /// for a series that skips weekends: five ticks at equal time offsets would
    /// cluster or land in gaps, whereas five ticks at equal data offsets always
    /// sit on real observations. Labels drop to month/year past about a year,
    /// where day numbers stop being readable and stop mattering.
    static func dailyTicks(_ points: [PlotPoint], count: Int = 5) -> [ChartTick] {
        guard points.count >= 2 else { return [] }

        let spanMs = points[points.count - 1].t - points[0].t
        let overAYear = spanMs > 370 * 86_400_000
        let step = max(1, (points.count - 1) / max(1, count - 1))

        var ticks: [ChartTick] = []
        var index = 0
        while index < points.count {
            let point = points[index]
            ticks.append(
                ChartTick(
                    x: point.x,
                    label: overAYear ? ChartLabels.monthYear(point.t) : ChartLabels.dayMonth(point.t)
                )
            )
            index += step
        }
        return ticks
    }
}

// MARK: - Calendar and labels

/// NY calendar dates, for deciding which bars belong to the same session.
///
/// The market's day is the only day that matters here: a 20:00 ET bar and an
/// 04:00 ET bar the next morning are different sessions even though in Warsaw
/// they are both "the small hours". The device's own time zone must not enter
/// into it, which is why this pins one.
enum NYCalendar {
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "America/New_York")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func isoDate(atEpochMs ms: Int) -> String {
        formatter.string(from: Date(timeIntervalSince1970: TimeInterval(ms) / 1000))
    }
}

/// Chart text, in the app's one locale.
///
/// pl-PL like every other formatted value in this app — a chart axis reading
/// "Aug" above a "23 708,11 zł" summary would look like a bug, because it
/// would be one.
enum ChartLabels {
    static let locale = Locale(identifier: "pl_PL")

    /// `TimeInterval`, not `Double`, and not merely to keep the CI grep quiet:
    /// a moment in time is the one quantity in this app that is legitimately
    /// floating point. Money never is.
    private static func date(_ ms: Int) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    static func dayMonth(_ ms: Int) -> String {
        date(ms).formatted(.dateTime.day().month(.abbreviated).locale(locale))
    }

    static func monthYear(_ ms: Int) -> String {
        date(ms).formatted(.dateTime.month(.abbreviated).year(.twoDigits).locale(locale))
    }

    static func hourMinute(_ ms: Int) -> String {
        date(ms).formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(locale))
    }

    /// The scrubber's headline date. Intraday needs the clock; daily does not,
    /// and printing 00:00 beside a daily close would be a small lie.
    static func scrubbed(_ ms: Int, granularity: ChartRange.Granularity) -> String {
        switch granularity {
        case .intraday:
            date(ms).formatted(
                .dateTime.day().month(.abbreviated)
                    .hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
                    .locale(locale)
            )
        case .daily:
            date(ms).formatted(.dateTime.day().month(.abbreviated).year().locale(locale))
        }
    }

    /// The baseline date in the callout's "since" line, at the scale the
    /// window is read at: a clock time within one session, a day and month
    /// up to about a year, a month and two-digit year past that. The 370-day
    /// threshold is `dailyTicks`', so the callout and the axis switch scale
    /// together. `spanMs` is the window's `last.t - first.t` — a time span,
    /// never money.
    static func since(_ ms: Int, granularity: ChartRange.Granularity, spanMs: Int) -> String {
        switch granularity {
        case .intraday:
            spanMs < 86_400_000 ? hourMinute(ms) : dayMonth(ms)
        case .daily:
            spanMs <= 370 * 86_400_000 ? dayMonth(ms) : monthYear(ms)
        }
    }

    /// Parses a plain 'YYYY-MM-DD' the server sent. Fixed UTC and
    /// `en_US_POSIX`, so a device locale with a non-Gregorian calendar cannot
    /// change what a server date means.
    private static let isoDayParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// The UTC calendar date of an instant, as 'YYYY-MM-DD' — the twin of
    /// `NYCalendar.isoDate(atEpochMs:)`, and the day key every DAILY range is
    /// read by.
    ///
    /// A daily point's `t` is an anchor the server chose, not a moment
    /// anything happened: midnight UTC for instrument and portfolio bars
    /// (`portfolio-series.ts`), noon UTC for the options value series
    /// (`ny-dates.ts`). Read through the New York calendar, midnight UTC names
    /// the day BEFORE — which would put every trade marker one bar to the left
    /// and look almost right. Only intraday points are real instants, and
    /// those the server itself grouped by NY date, so only those ask
    /// `NYCalendar`.
    static func utcDate(atEpochMs ms: Int) -> String {
        isoDayParser.string(from: date(ms))
    }

    /// A server calendar date ('YYYY-MM-DD') rendered like the daily scrubber
    /// label — the same pl-PL shape the web caption uses. Pinned to UTC NOON
    /// before rendering, the app's standard calendar idiom (and exactly what
    /// the web caption does), so no device time zone can shift a date onto the
    /// day before. Returns the raw string when it will not parse: an
    /// unrecognised date is shown as it arrived rather than replaced by a guess.
    static func isoDay(_ iso: String) -> String {
        guard let parsed = isoDayParser.date(from: iso) else { return iso }
        return parsed.addingTimeInterval(12 * 60 * 60)
            .formatted(.dateTime.day().month(.abbreviated).year().locale(locale))
    }

    /// Human name of an extended-hours phase — the shading is decorative, and
    /// this is what actually carries the meaning.
    static func phase(_ marker: SessionMarker) -> String {
        switch marker {
        case .pre: "Pre-market"
        case .post: "After hours"
        }
    }
}
