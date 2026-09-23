import Charts
import SwiftUI

/// What the plotted numbers MEAN, which decides how every label is formatted.
///
/// A percent axis under a money formatter would print "12,40 zł" over a
/// return curve — the kind of wrong that reads as merely odd until someone
/// believes it.
enum ChartUnit: Sendable, Equatable {
    case money
    case percent
    /// An exchange rate: four fraction digits and no currency suffix. The
    /// USD/PLN market screen's unit — "3,7955", never "3,80 zł". Arithmetic
    /// is money-shaped (the percent guard is the money one); only the
    /// printing differs.
    case rate
}

/// What the chart has to say for itself before it draws anything.
enum ChartState: Sendable, Equatable {
    case ready
    case loading
    case empty
    case error
}

/// The one chart. Swift Charts, mirroring `value-chart.tsx` decision for
/// decision so the same portfolio does not look like two different products.
///
/// Money discipline at the render boundary: every float here came from
/// `PlotPoints` and is geometry. Every VISIBLE figure — axis labels, the
/// scrubber — is formatted from the decimal string the point carries, through
/// `Money.swift`.
///
/// Colours come only from `Tokens`, and the stroke direction from
/// `directionOf()` on `Decimal` — never a ternary on a sign at the call site.
///
/// A FIXED height, shared by the chart and by every one of its non-drawing
/// states, so switching a range never shifts the layout underneath a thumb
/// that is about to tap the next tab.
struct ValueChart: View {
    let points: [ChartPoint]
    let state: ChartState
    let granularity: ChartRange.Granularity
    /// Display currency of the plotted values. Ignored when `unit` is
    /// `.percent`, which has no currency to be in.
    let currency: String
    let excludedSymbols: [String]
    let partialDays: Int
    /// ISO date from which the plotted values are the app's own model
    /// estimates rather than real traded prices — the options series' seam.
    /// `nil` on every other chart. Never derived here: the server discloses it
    /// or nobody does.
    var estimatedFrom: String?
    var emptyMessage: String = "No data for this range."
    /// What the values are. `.percent` is the portfolio chart's Return mode.
    var unit: ChartUnit = .money
    /// Line or candles. Candles need `o`/`h`/`l` on the points; a range whose
    /// bars carry none falls back to the line rather than drawing an empty
    /// frame, because a Candles tab that produced nothing would look broken
    /// rather than honest.
    var style: ChartStyle = .line
    /// The plotting quantity — `v` or `r`. Held here rather than derived from
    /// `unit` because the two are separate questions: a future chart could
    /// plot a value series on a percent axis.
    var mode: ChartMode = .value
    /// The selected window in plain words ("past month"), for the change row
    /// above the plot. The chart knows only its granularity, so the caller
    /// names the window; `nil` prints the figures without one.
    var windowLabel: String? = nil
    /// The user's own trades, to be drawn ON the line. Empty on any surface
    /// that has none to show — the default, so no existing call site changes.
    var trades: [TradeMark] = []
    /// Whether a trade's unit price is comparable with the plotted quantity.
    /// True only on the instrument PRICE chart; a total-value or return line
    /// is a different kind of number and matches by day alone.
    var matchOnPrice: Bool = false

    @State private var scrubbed: PlotPoint?
    @State private var calloutSize: CGSize = .zero
    /// The tapped trade marker, if any. Cleared by a scrub, by a tap on empty
    /// plot, by the mark being tapped again, and by the plot underneath it
    /// changing at all — see `body`'s `onChange` pair.
    @State private var selectedMark: PlacedTradeMark?
    /// What was open when the CURRENT gesture began, so a second tap on an
    /// open mark can close it. `onChanged` fires on touch-down and clears
    /// `selectedMark` before `onEnded` ever runs, so `onEnded` has nothing
    /// left to compare against unless the value is captured here first.
    @State private var markBeforeGesture: PlacedTradeMark?
    /// The current gesture's start point, used only as that gesture's
    /// identity: it tells `onChanged` whether this callback is the FIRST of a
    /// new gesture (capture) or a later one (do not overwrite the capture).
    /// `onEnded` clears it, so an ordinary tap always re-captures; when the
    /// enclosing `ScrollView` steals a drag and `onEnded` never fires, the
    /// next gesture's different start point re-captures instead.
    @State private var gestureStart: CGPoint?

    private static let height: CGFloat = 220
    /// The change row's height, reserved in EVERY state — see `changeRow`.
    private static let changeRowHeight: CGFloat = 18
    /// Travel under which a gesture was a tap, not a scrub.
    private static let tapTravel: CGFloat = 10
    /// Hit slop around a marker's plotted position.
    private static let tapSlop: CGFloat = 24

    var body: some View {
        // Mapped ONCE per render and handed down. Recomputing it in the
        // captions as well would run the whole crossing twice a frame, and on
        // a 5Y daily series that is over a thousand points for nothing.
        let plotted = PlotPoints.map(points, granularity: granularity, mode: mode)
        // Placed ONCE per render, beside the mapping, and handed to both the
        // chart and the captions: the caption's count and the drawn marks are
        // two readings of one answer and must never disagree.
        let placement = TradeMarkers.place(
            trades,
            on: plotted,
            granularity: granularity,
            matchOnPrice: matchOnPrice
        )

        return VStack(alignment: .leading, spacing: 6) {
            changeRow(plotted)
            frame(plotted, placement)
            captions(plotted, placement)
        }
        // BOTH `onChange`s live HERE, on the outermost view, and must stay
        // here. An `onChange` only fires while the view carrying it stays in
        // the hierarchy: it re-seeds its baseline whenever it is re-inserted.
        // Everything below this line has a SHORTER lifetime than
        // `selectedMark` — `frame` swaps the whole chart for a placeholder
        // rectangle on every `.loading`, and `PortfolioChartStore.reload()`
        // enters `.loading` on every range AND chip switch — so an `onChange`
        // attached inside the chart is destroyed and re-seeded exactly when it
        // was supposed to fire, and a callout for the OLD plot stays open over
        // the new one. State that outlives a subtree can only be guarded from
        // outside it.
        //
        // A selection belongs to ONE plot. Switching the portfolio chip, the
        // range, the mode, or deleting the row on the Transactions screen all
        // rebuild the marks underneath an open callout — and a range switch
        // changes what `PlotPoint.x` even MEANS (an index intraday, days since
        // the epoch daily), so a remembered mark would clamp its box against
        // the left edge with no glyph under it, naming a trade that is no
        // longer there. A mark that survives with the same point index and the
        // same trades is re-adopted at its new position; anything else closes.
        .onChange(of: placement.marks) { _, marks in
            guard let selected = selectedMark else { return }
            selectedMark = marks.first {
                $0.pointIndex == selected.pointIndex && $0.trades == selected.trades
            }
        }
        // The plot is about to be replaced or has just been: a reload begins
        // in `.loading` with the OLD marks still placed, so the marks alone
        // would not have changed yet. Nothing is worth keeping open across a
        // state change of the surface the callout is describing.
        .onChange(of: state) { _, _ in
            selectedMark = nil
        }
    }

    // MARK: - The change row

    /// "+12,40 zł  +3,12%  past month" — the window's change, first to last
    /// visible point, on `Decimal` from the strings the points carry. Same
    /// pair the dashed baseline and the stroke colour are measured from.
    ///
    /// The row keeps its height while loading, empty, errored or with a
    /// single point: the 220pt plot beneath must never jump when a range
    /// finishes loading under a thumb — the rule `frame` already follows.
    @ViewBuilder
    private func changeRow(_ plotted: [PlotPoint]) -> some View {
        if state == .ready,
           let change = ChartChanges.window(plotted, unit: unit),
           let line = ChartChanges.windowLine(change, unit: unit, currency: currency, windowLabel: windowLabel) {
            // On the rounded text, like the sign: a "0,00 zł" is never tinted.
            let tint = Color(ChartChanges.directionOf(change, unit: unit, currency: currency).token)

            HStack(spacing: 8) {
                switch unit {
                case .money:
                    Text(ChartChanges.signedMoney(change.absolute, currency: currency))
                        .foregroundStyle(tint)
                    // Absent, not "0,00%", when the window starts at or
                    // below zero — the amount alone is the honest reading.
                    if let percent = change.percent {
                        Text(fmtPct(percent))
                            .foregroundStyle(tint)
                    }
                case .percent:
                    // Percentage points: the plotted quantity is already a
                    // return, and a percent of it would mean nothing.
                    Text(ChartChanges.points(change.absolute))
                        .foregroundStyle(tint)
                case .rate:
                    Text(ChartChanges.signedRate(change.absolute))
                        .foregroundStyle(tint)
                    if let percent = change.percent {
                        Text(fmtPct(percent))
                            .foregroundStyle(tint)
                    }
                }
                if let windowLabel {
                    Text(windowLabel)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }
            .font(.system(.caption, weight: .semibold))
            .monospacedDigit()
            .frame(height: ValueChart.changeRowHeight)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(ChartChanges.spoken(line))
        } else {
            Color.clear
                .frame(height: ValueChart.changeRowHeight)
        }
    }

    @ViewBuilder
    private func frame(_ plotted: [PlotPoint], _ placement: TradeMarkerPlacement) -> some View {
        if state == .loading {
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(Tokens.surface2))
                .frame(height: ValueChart.height)
        } else if state == .ready, plotted.count >= 2 {
            // The marks are a SIGHTED affordance: VoiceOver reads the
            // individual trades from the transaction list and the lot menus,
            // which is where they can also be acted on. What the chart owes is
            // the count.
            //
            // ONE `chart()` call, with the label applied unconditionally. An
            // `if marked.isEmpty` here would be a `_ConditionalContent`, and
            // flipping that branch — tap a mark on "All", then pick a
            // portfolio with no trades — destroys and rebuilds the whole chart
            // subtree, discarding every `onChange` inside it. The label is a
            // string, so "no marks" is expressed by an EMPTY string (which
            // names nothing and leaves the group unannounced) rather than by a
            // different view.
            chart(plotted, placement)
                .frame(height: ValueChart.height)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(ValueChart.markerAccessibility(placement))
        } else {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(Tokens.borderSubtle), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .frame(height: ValueChart.height)
                .overlay(
                    Text(state == .error
                        ? "Couldn't load this range. Pick another one or try again."
                        : emptyMessage)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color(Tokens.textMuted))
                        .padding(.horizontal, 24)
                )
        }
    }

    // MARK: - The chart

    /// Every VISIBLE figure goes through here, from the point's decimal
    /// STRING — never from the plotted float. The float is geometry.
    private func label(_ raw: String) -> String {
        guard let value = dec(raw) else { return "—" }
        switch unit {
        case .money: return fmtMoney(value, currency: currency)
        case .percent: return fmtPct(value)
        case .rate: return fmtDecimal(value, minFractionDigits: 4, maxFractionDigits: 4)
        }
    }

    /// The Y-axis tick text. Swift Charts interpolates its own "nice" tick
    /// values, so there is no source decimal string for them — display-only
    /// labels over interpolated geometry, the same concession
    /// `value-chart.tsx` makes. A rate keeps its four digits on the axis:
    /// a day's move in USD/PLN lives entirely in the third and fourth.
    private func axisLabel(_ y: Double, digits: Int) -> String {
        switch unit {
        case .money: fmtMoney(Decimal(y), currency: currency, fractionDigits: digits)
        case .percent: fmtPct(Decimal(y))
        case .rate: fmtDecimal(Decimal(y), minFractionDigits: 4, maxFractionDigits: 4)
        }
    }

    /// Whether candles are actually being drawn: asked for AND available.
    private func drawsCandles(_ plotted: [PlotPoint]) -> Bool {
        style == .candle && PlotPoints.hasCandles(plotted)
    }

    private func chart(_ plotted: [PlotPoint], _ placement: TradeMarkerPlacement) -> some View {
        let direction = direction(of: plotted)
        let stroke = Color(direction.sparklineToken)
        let candles = drawsCandles(plotted)
        let spans = PlotPoints.spans(plotted)
        let ticks = granularity == .intraday
            ? PlotPoints.intradayTicks(plotted)
            : PlotPoints.dailyTicks(plotted)
        let digits = PlotPoints.axisFractionDigits(plotted)
        // Computed once and used TWICE: as the Y scale, and as the floor the
        // area fill is anchored to. The two must be the same number — see the
        // `yStart` on `AreaMark` below.
        let domain = PlotPoints.yDomain(plotted)

        return Chart {
            // Bands first, so the wash sits UNDER the line. `surface2` is the
            // raised-surface token — one step off the card in both themes, and
            // neutral: a gain/loss tint here would read as a second series.
            ForEach(spans) { span in
                RectangleMark(
                    xStart: .value("from", span.from),
                    xEnd: .value("to", span.to)
                )
                .foregroundStyle(Color(Tokens.surface2).opacity(0.7))
            }

            // Yahoo-style baseline at the window's first visible value — the
            // level `direction` is measured against. Deliberately not a
            // gain/loss token, so it can never read as data.
            RuleMark(y: .value("baseline", plotted[0].y))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [6, 4]))
                .foregroundStyle(Color(Tokens.borderStrong))

            ForEach(plotted) { point in
                if candles, let bar = point.candle {
                    // Wick first, body over it — a doji whose body is a
                    // hairline must still sit on top of its own wick.
                    RuleMark(
                        x: .value("x", point.x),
                        yStart: .value("low", bar.l),
                        yEnd: .value("high", bar.h)
                    )
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Color(ValueChart.barToken(open: bar.o, close: point.y)))

                    // Open→close as a thick rule rather than a RectangleMark:
                    // a rectangle needs a width in DATA units, which on the
                    // categorical intraday axis is 1 and on the continuous
                    // daily axis is a day in milliseconds. A fixed-point line
                    // width is the same bar at both scales.
                    RuleMark(
                        x: .value("x", point.x),
                        yStart: .value("open", bar.o),
                        yEnd: .value("close", point.y)
                    )
                    .lineStyle(StrokeStyle(lineWidth: 5, lineCap: .butt))
                    .foregroundStyle(Color(ValueChart.barToken(open: bar.o, close: point.y)))
                } else if !candles {
                    // `yStart` pinned to the scale's own floor rather than the
                    // one-argument `y:` form. Without it the area's geometry is
                    // open-ended downwards: Swift Charts hands the gradient an
                    // unbounded rect, so only the very top of the ramp lands on
                    // the plot — the fill reads as one flat wash — and the
                    // shape itself is painted straight down over everything
                    // BELOW the chart, which on the ticker screen tinted the
                    // whole scrolling page red. The clip below stops the
                    // bleeding; this is what makes the fade correct.
                    AreaMark(
                        x: .value("x", point.x),
                        yStart: .value("floor", domain.lowerBound),
                        yEnd: .value("value", point.y)
                    )
                        .interpolationMethod(.monotone)
                        .foregroundStyle(
                            .linearGradient(
                                colors: [stroke.opacity(0.25), stroke.opacity(0)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )

                    LineMark(x: .value("x", point.x), y: .value("value", point.y))
                        .interpolationMethod(.monotone)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                        .foregroundStyle(stroke)
                }
            }

            if candles {
                // The continuity line under the bars, muted: a range where
                // only some points carry OHLC would otherwise show islands of
                // candles with nothing between them.
                ForEach(plotted) { point in
                    LineMark(x: .value("x", point.x), y: .value("close", point.y))
                        .interpolationMethod(.monotone)
                        .lineStyle(StrokeStyle(lineWidth: 1))
                        .foregroundStyle(Color(Tokens.borderStrong))
                }
            }

            // After the line and the candles so a marker is never buried
            // under the area fill, and before the scrub marks so it never
            // hides the dot saying which observation is under the finger.
            //
            // Y comes from the MATCHED POINT, never from the trade's price:
            // that is what "on the line" means, and it keeps the traded
            // amount out of the float world entirely.
            ForEach(placement.marks) { mark in
                PointMark(x: .value("x", mark.x), y: .value("value", mark.y))
                    .symbol { TradeMarkGlyph(mark: mark) }
            }

            if let scrubbed {
                RuleMark(x: .value("x", scrubbed.x))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Color(Tokens.borderStrong))

                // The dot that says WHICH observation, since the rule alone
                // only says where along the axis.
                RectangleMark(
                    x: .value("x", scrubbed.x),
                    y: .value("value", scrubbed.y),
                    width: .fixed(6),
                    height: .fixed(6)
                )
                .cornerRadius(3)
                .foregroundStyle(stroke)
            }
        }
        // Without this Swift Charts uses the exact data extent, which pins the
        // highest observation to the top edge — see `yDomain`.
        .chartYScale(domain: domain)
        // The X window has to be stated too — see `xDomain`. Without it a
        // daily range is drawn inside a frame that starts at day zero (1970)
        // and the whole series collapses against the right edge.
        .chartXScale(domain: PlotPoints.xDomain(plotted))
        // Marks are NOT clipped to the plot area by default, and a mark whose
        // geometry runs past it — the area fill, a candle wick at the domain
        // edge — is drawn over whatever sits below the chart. In a ScrollView
        // that is the entire page. Verified in the simulator: without this the
        // fill paints over every card down to the tab bar.
        .chartPlotStyle { plot in plot.clipped() }
        .chartXAxis {
            AxisMarks(values: ticks.map(\.x)) { value in
                AxisGridLine().foregroundStyle(.clear)
                AxisTick().foregroundStyle(.clear)
                AxisValueLabel {
                    // Label from the tick's own text, which was formatted from
                    // the point's REAL timestamp. On an intraday chart the axis
                    // position is an index and means nothing on its own.
                    if let x = value.as(Double.self),
                       let tick = ticks.first(where: { $0.x == x }) {
                        Text(tick.label)
                            .font(.caption2)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing) { value in
                AxisGridLine()
                    .foregroundStyle(Color(Tokens.borderSubtle))
                AxisValueLabel {
                    if let y = value.as(Double.self) {
                        Text(axisLabel(y, digits: digits))
                            .font(.caption2)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                let plot = geometry[proxy.plotFrame!]

                ZStack(alignment: .topLeading) {
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { drag in
                                    // The FIRST callback of this gesture is
                                    // the only moment the pre-gesture
                                    // selection still exists — remember it, or
                                    // `onEnded` cannot tell a second tap on an
                                    // open mark from a first tap on a closed
                                    // one. Keyed on the gesture's own start
                                    // point so later callbacks do not overwrite
                                    // the capture with the `nil` set below.
                                    if gestureStart != drag.startLocation {
                                        gestureStart = drag.startLocation
                                        markBeforeGesture = selectedMark
                                    }
                                    // A finger on the plot is asking about the
                                    // line; the marker's box gets out of the way.
                                    selectedMark = nil
                                    scrubbed = nearest(to: drag.location, in: plotted, proxy: proxy, geometry: geometry)
                                }
                                .onEnded { drag in
                                    scrubbed = nil
                                    // Taken before anything else clears it,
                                    // and cleared here so the next gesture
                                    // starts from a blank capture whatever it
                                    // starts from on screen.
                                    let wasOpen = markBeforeGesture
                                    markBeforeGesture = nil
                                    gestureStart = nil
                                    // Under 10pt of travel is a tap, however
                                    // long the finger rested. Anything more was
                                    // a scrub, and a scrub ends in nothing
                                    // selected — the behaviour before markers.
                                    //
                                    // Measured from the gesture's OWN
                                    // translation rather than from a remembered
                                    // origin: the enclosing `ScrollView` can
                                    // steal a drag, and `onEnded` never fires
                                    // when it does, so any `@State` origin
                                    // survives into the next gesture and makes
                                    // the following genuine tap read as a
                                    // scrub.
                                    let travel = hypot(drag.translation.width, drag.translation.height)
                                    guard travel < ValueChart.tapTravel else {
                                        selectedMark = nil
                                        return
                                    }
                                    let hit = mark(at: drag.location, in: placement, proxy: proxy, geometry: geometry)
                                    // Tapping the open mark again closes it —
                                    // the box is a toggle, which is what a
                                    // second tap on the same thing means.
                                    // Compared against what was open BEFORE
                                    // this gesture: `selectedMark` was already
                                    // set to nil on touch-down, so comparing
                                    // with it here could never be true.
                                    selectedMark = (hit == wasOpen) ? nil : hit
                                }
                        )

                    // The callout FLOATS over the plot; it is not a chart
                    // annotation. An annotation participates in the chart's
                    // layout — Swift Charts reserves room for it outside the
                    // plot area — so attaching one to the scrub rule shrank
                    // the plot the instant a finger landed and the whole
                    // series visibly dropped, then sprang back on release.
                    // The height here is fixed precisely so nothing moves;
                    // a readout that moves the data it is describing is
                    // worse than no readout. Recharts' `<Tooltip>` on the
                    // web is an absolutely-positioned overlay for the same
                    // reason, so this is also what parity looks like.
                    if let scrubbed, let x = proxy.position(forX: scrubbed.x) {
                        callout(scrubbed, in: plotted)
                            .background(measuringCallout)
                            .offset(
                                x: calloutX(centeredOn: plot.minX + x, within: plot),
                                y: plot.minY + 4
                            )
                            // The finger is already down on this exact spot:
                            // a callout that could take the touch would end
                            // the drag the moment it appeared.
                            .allowsHitTesting(false)
                    } else if let selectedMark, let x = proxy.position(forX: selectedMark.x) {
                        // The SAME overlay path as the scrub callout, for the
                        // same reason: a callout that participates in the
                        // chart's layout shrinks the plot the instant it
                        // appears, and the series visibly drops.
                        TradeMarkCallout(mark: selectedMark)
                            .background(measuringCallout)
                            .offset(
                                x: calloutX(centeredOn: plot.minX + x, within: plot),
                                y: plot.minY + 4
                            )
                            .allowsHitTesting(false)
                    }
                }
            }
        }
    }

    /// Centred on the finger, then pushed back inside the plot at both edges —
    /// a readout that hangs off the side of the chart is unreadable exactly
    /// when the first and last points are the ones being inspected.
    private func calloutX(centeredOn x: CGFloat, within plot: CGRect) -> CGFloat {
        let ideal = x - calloutSize.width / 2
        let last = max(plot.minX, plot.maxX - calloutSize.width)
        return min(max(ideal, plot.minX), last)
    }

    /// Width, measured rather than guessed: the callout is as wide as the date
    /// and the amount make it, and both change with the range and the currency.
    ///
    /// `onChange` on a `GeometryReader`'s size rather than a `PreferenceKey`:
    /// `onPreferenceChange` takes a `@Sendable` closure, which cannot assign to
    /// this view's `@State` under strict concurrency.
    private var measuringCallout: some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { calloutSize = proxy.size }
                .onChange(of: proxy.size) { _, size in calloutSize = size }
        }
    }

    /// The point under the finger.
    ///
    /// Nearest by X rather than the value the proxy reports directly: on a
    /// categorical axis the proxy answers with a fractional index that lies
    /// between two real observations, and rounding it would silently pick the
    /// wrong side at the edges.
    private func nearest(
        to location: CGPoint,
        in plotted: [PlotPoint],
        proxy: ChartProxy,
        geometry: GeometryProxy
    ) -> PlotPoint? {
        let origin = geometry[proxy.plotFrame!].origin
        guard let x: Double = proxy.value(atX: location.x - origin.x) else { return nil }
        return plotted.min { abs($0.x - x) < abs($1.x - x) }
    }

    /// The trade marker under a tap, if the tap was close enough to one.
    ///
    /// 24pt of slop around an 11pt glyph makes a 48pt target — clear of the
    /// 44pt floor every other control in the app keeps. Nearest wins, so two
    /// marks on adjacent points cannot both claim the same touch.
    private func mark(
        at location: CGPoint,
        in placement: TradeMarkerPlacement,
        proxy: ChartProxy,
        geometry: GeometryProxy
    ) -> PlacedTradeMark? {
        let origin = geometry[proxy.plotFrame!].origin
        var best: PlacedTradeMark?
        var bestDistance = ValueChart.tapSlop

        for candidate in placement.marks {
            guard let x = proxy.position(forX: candidate.x),
                  let y = proxy.position(forY: candidate.y)
            else { continue }
            let distance = hypot(origin.x + x - location.x, origin.y + y - location.y)
            if distance <= bestDistance {
                best = candidate
                bestDistance = distance
            }
        }
        return best
    }

    /// `plotted` is the visible window, whose first point is the baseline the
    /// since-line measures from — the same one the dashed rule marks.
    private func callout(_ point: PlotPoint, in plotted: [PlotPoint]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Text(ChartLabels.scrubbed(point.t, granularity: granularity))
                // The band says "not the regular session"; this says WHICH one.
                // Shading alone is not a label.
                if let phase = point.phase {
                    Text("· \(ChartLabels.phase(phase))")
                }
            }
            .font(.caption2)
            .foregroundStyle(Color(Tokens.textMuted))

            // Formatted from the decimal STRING, never from the plotted float.
            Text(label(point.raw))
                .font(.system(.caption, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(Color(Tokens.textPrimary))

            // "+3,12% since 1 sie" — from the window's first visible point,
            // on `Decimal`. At the first point itself this reads a flat
            // "0,00%", which is the true answer there. The callout is an
            // overlay, so the extra line re-measures through
            // `measuringCallout` and re-clamps in `calloutX`; the plot does
            // not move.
            if let change = ChartChanges.sinceStart(of: point, in: plotted, unit: unit),
               let first = plotted.first, let last = plotted.last,
               let line = ChartChanges.scrubLine(
                   change,
                   unit: unit,
                   currency: currency,
                   since: ChartLabels.since(first.t, granularity: granularity, spanMs: last.t - first.t)
               ) {
                Text(line)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(Color(ChartChanges.directionOf(change, unit: unit, currency: currency).token))
                    .accessibilityLabel(ChartChanges.spoken(line))
            }

            // A candle says four things and the close alone says one. Only in
            // candle mode, and only where a bar exists.
            if let bar = point.candle, drawsCandles([point]) {
                Text(ValueChart.ohlcLine(bar, unit: unit, currency: currency))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }

    /// Direction of the whole visible window, on `Decimal` — last versus first,
    /// through the same `directionOf()` every other gain/loss signal uses. The
    /// plotted floats are never subtracted to decide a colour.
    private func direction(of plotted: [PlotPoint]) -> Direction {
        guard plotted.count >= 2,
              let first = dec(plotted[0].raw),
              let last = dec(plotted[plotted.count - 1].raw)
        else { return .neutral }
        return directionOf(last - first)
    }

    // MARK: - Captions

    @ViewBuilder
    private func captions(_ plotted: [PlotPoint], _ placement: TradeMarkerPlacement) -> some View {
        let phases = Set(PlotPoints.spans(plotted).map(\.phase))
        let unplaced = placement.unplacedInWindow

        VStack(alignment: .leading, spacing: 2) {
            if !phases.isEmpty {
                // Named phases, so the shading is never the only thing carrying
                // the meaning.
                Text("Shaded: \(phases.map { ChartLabels.phase($0).lowercased() }.sorted().joined(separator: " and "))")
            }
            if !excludedSymbols.isEmpty {
                // Permanent data, not an error: these symbols have no price
                // history at all, and zeroing them into the series would be a
                // quiet lie about what the portfolio was worth.
                Text("Not included (no price history): \(excludedSymbols.joined(separator: ", "))")
            }
            if partialDays > 0 {
                Text("Missing quotes for \(partialDays) \(partialDays == 1 ? "day" : "days") in this range.")
            }
            if unplaced > 0 {
                // A trade on a day the line has no reading for — a holiday, a
                // gap in the data, or a point the downsampler dropped. It
                // cannot be marked, so it is counted: a missing mark must
                // never be silent.
                Text("\(unplaced) \(unplaced == 1 ? "trade" : "trades") on days with no reading in this range.")
            }
            if let estimatedFrom {
                // The seam, named — the counterpart of the web caption. Points
                // before this date are real traded closes; from it on they are
                // the app's own model estimates, the same numbers the cards
                // use. A step in the line here is that difference, disclosed.
                Text("Estimated values from \(ChartLabels.isoDay(estimatedFrom)) — earlier points are traded closing prices.")
            }
        }
        .font(.caption2)
        .foregroundStyle(Color(Tokens.textMuted))
    }

    /// "3 trades marked" — the count, in words, for the chart's container
    /// label. Empty when there is nothing marked, which is no label at all.
    static func markerAccessibility(_ placement: TradeMarkerPlacement) -> String {
        let count = placement.marks.reduce(0) { $0 + $1.trades.count }
        guard count > 0 else { return "" }
        return "\(count) \(count == 1 ? "trade" : "trades") marked"
    }

    /// A bar's colour: up-days and down-days are the gain and loss tokens, and
    /// an unchanged bar is neither. Decided on `Decimal` through the same
    /// `directionOf()` every other gain/loss signal uses — the plotted floats
    /// are geometry and are never subtracted to choose a colour.
    ///
    /// The two arguments are already floats, so the comparison is done on
    /// their ORDER rather than on a difference: `<` and `>` on two coordinates
    /// answer "which is higher on screen", which is exactly the question, and
    /// no arithmetic result is ever shown to anyone.
    static func barToken(open: Double, close: Double) -> DesignToken {
        if close > open { return Tokens.gain }
        if close < open { return Tokens.loss }
        return Tokens.textMuted
    }

    /// "O 228,00 · H 232,40 · L 228,50" — the three figures the close does not
    /// carry. Formatted through `Money.swift` from the strings the bar was
    /// built from... except that a `PlotPoint.Candle` holds only coordinates,
    /// so these are formatted from the floats and are DISPLAY-ONLY, exactly
    /// like the interpolated axis labels above. They are never totalled,
    /// compared or fed back into anything.
    static func ohlcLine(_ bar: PlotPoint.Candle, unit: ChartUnit = .money, currency: String) -> String {
        func figure(_ value: Double) -> String {
            switch unit {
            case .rate: fmtDecimal(Decimal(value), minFractionDigits: 4, maxFractionDigits: 4)
            case .money, .percent: fmtMoney(Decimal(value), currency: currency)
            }
        }
        return "O \(figure(bar.o)) · H \(figure(bar.h)) · L \(figure(bar.l))"
    }
}
