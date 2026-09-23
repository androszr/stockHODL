import Charts
import SwiftUI

/// You against the market: both lines rebased to 100 on the first day they
/// share, so the gap between them is the whole story.
///
/// Mirrors `src/components/charts/comparison-chart.tsx` decision for decision.
/// Floats come only from `PlotPoints` and are geometry. Every visible figure
/// is formatted from the decimal string the point carries, through
/// `fmtDecimal` — index figures are unitless, never money. The portfolio
/// stroke is `directionOf(final − 100)`; the benchmark is dashed
/// `Tokens.benchmark`, so the two lines stay distinguishable with colour
/// filters off.
///
/// A degraded benchmark draws ONE line and a caption. It never invents a
/// second line.
struct ComparisonChart: View {
    let portfolio: [ChartPoint]
    let benchmark: [ChartPoint]
    let degradedReason: BenchmarkRefusal?

    @State private var scrubbed: PlotPoint?

    private static let height: CGFloat = 220
    private static let indexBase: Decimal = 100
    private static let portfolioLabel = "Your portfolio"
    private static let benchmarkLabel = "S&P 500 (SPY, in PLN)"

    var body: some View {
        let portfolioPlot = PlotPoints.map(portfolio, granularity: .daily)
        let benchmarkPlot = PlotPoints.map(benchmark, granularity: .daily)
        let combined = portfolioPlot + benchmarkPlot

        VStack(alignment: .leading, spacing: 6) {
            frame(portfolioPlot: portfolioPlot, benchmarkPlot: benchmarkPlot, combined: combined)
            legend(hasBenchmark: !benchmarkPlot.isEmpty)
            if degradedReason != nil {
                Text("No benchmark line: the S&P 500 history needed for this span is not available yet. Nothing is drawn in its place.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func frame(
        portfolioPlot: [PlotPoint],
        benchmarkPlot: [PlotPoint],
        combined: [PlotPoint]
    ) -> some View {
        if portfolioPlot.count >= 2 {
            chart(portfolioPlot: portfolioPlot, benchmarkPlot: benchmarkPlot, combined: combined)
                .frame(height: ComparisonChart.height)
        } else {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(Tokens.borderSubtle), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .frame(height: ComparisonChart.height)
                .overlay(
                    Text("Not enough history to compare yet.")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color(Tokens.textMuted))
                        .padding(.horizontal, 24)
                )
        }
    }

    private func chart(
        portfolioPlot: [PlotPoint],
        benchmarkPlot: [PlotPoint],
        combined: [PlotPoint]
    ) -> some View {
        let direction = lineDirection(portfolioPlot)
        let stroke = Color(direction.sparklineToken)
        let ticks = PlotPoints.dailyTicks(portfolioPlot)
        let domain = yDomain(combined)

        return Chart {
            RuleMark(y: .value("base", 100.0))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [6, 4]))
                .foregroundStyle(Color(Tokens.borderStrong))

            ForEach(portfolioPlot) { point in
                LineMark(
                    x: .value("x", point.x),
                    y: .value("portfolio", point.y),
                    series: .value("series", "portfolio")
                )
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 1.5))
                .foregroundStyle(stroke)
            }

            ForEach(benchmarkPlot) { point in
                LineMark(
                    x: .value("x", point.x),
                    y: .value("benchmark", point.y),
                    series: .value("series", "benchmark")
                )
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                .foregroundStyle(Color(Tokens.benchmark))
            }

            if let scrubbed {
                RuleMark(x: .value("x", scrubbed.x))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Color(Tokens.borderStrong))
            }
        }
        .chartYScale(domain: domain)
        .chartXScale(domain: PlotPoints.xDomain(combined.isEmpty ? portfolioPlot : combined))
        .chartPlotStyle { plot in plot.clipped() }
        .chartXAxis {
            AxisMarks(values: ticks.map(\.x)) { value in
                AxisGridLine().foregroundStyle(.clear)
                AxisTick().foregroundStyle(.clear)
                AxisValueLabel {
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
                        // Interpolated geometry, the same concession the
                        // value chart makes: Swift Charts picks nice ticks
                        // and there is no source decimal string for them.
                        Text(fmtDecimal(Decimal(y), minFractionDigits: 0, maxFractionDigits: 1))
                            .font(.caption2)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                let plot = geometry[proxy.plotFrame!]
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { drag in
                                let local = CGPoint(
                                    x: drag.location.x - plot.origin.x,
                                    y: drag.location.y - plot.origin.y
                                )
                                guard let x: Double = proxy.value(atX: local.x) else { return }
                                scrubbed = nearest(x, in: portfolioPlot)
                            }
                            .onEnded { _ in scrubbed = nil }
                    )

                if let scrubbed {
                    callout(scrubbed, benchmarkPlot: benchmarkPlot)
                        .offset(x: 8, y: 8)
                }
            }
        }
        .accessibilityLabel("Against the market")
    }

    /// Above or below where you started — the question this chart answers.
    /// Measured on Decimal from the last point's raw string, never from the
    /// plotted float.
    private func lineDirection(_ plotted: [PlotPoint]) -> Direction {
        guard let last = plotted.last, let value = dec(last.raw) else { return .neutral }
        return directionOf(value - ComparisonChart.indexBase)
    }

    /// The fitted window, expanded to include the index base so the dashed
    /// 100-line is never clipped off the plot.
    private func yDomain(_ points: [PlotPoint]) -> ClosedRange<Double> {
        let fitted = PlotPoints.yDomain(points)
        let lo = fitted.lowerBound < 100 ? fitted.lowerBound : 100
        let hi = fitted.upperBound > 100 ? fitted.upperBound : 100
        return lo...hi
    }

    private func nearest(_ x: Double, in points: [PlotPoint]) -> PlotPoint? {
        points.min { abs($0.x - x) < abs($1.x - x) }
    }

    private func callout(_ point: PlotPoint, benchmarkPlot: [PlotPoint]) -> some View {
        let twin = benchmarkPlot.first { $0.t == point.t }
        return VStack(alignment: .leading, spacing: 2) {
            Text(ChartLabels.scrubbed(point.t, granularity: .daily))
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
            Text("\(ComparisonChart.portfolioLabel): \(fmtIndex(point.raw))")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textPrimary))
            if let twin {
                Text("\(ComparisonChart.benchmarkLabel): \(fmtIndex(twin.raw))")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .padding(8)
        .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }

    private func legend(hasBenchmark: Bool) -> some View {
        Text(
            hasBenchmark
                ? "Both lines start at 100 on your first comparable day. Solid: \(ComparisonChart.portfolioLabel). Dashed: \(ComparisonChart.benchmarkLabel)."
                : "Both lines start at 100 on your first comparable day. Solid: \(ComparisonChart.portfolioLabel)."
        )
        .font(.caption2)
        .foregroundStyle(Color(Tokens.textMuted))
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Index figures are unitless — `fmtDecimal`, never `fmtMoney`.
    private func fmtIndex(_ raw: String) -> String {
        guard let value = dec(raw) else { return "—" }
        return fmtDecimal(value, minFractionDigits: 1, maxFractionDigits: 1)
    }
}
