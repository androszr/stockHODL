import SwiftUI

/// The Holdings chart: one header row of controls, one chart.
///
/// The layout is `portfolio-value-chart.tsx`'s: the ranges take the
/// shrinkable half and keep their own horizontal scroll, the Value/Return
/// toggle takes the fixed half and never shrinks below its tap targets. Two
/// rows would push the chart itself below the fold on a small phone.
///
/// Everything the chart shows is PLN, because the portfolio total is — the
/// series is summed server-side through the FX the engine already applied, and
/// a client that re-converted anything here would be a second money
/// implementation. In Return mode there is no currency at all: the axis is a
/// percentage, which is exactly why `ValueChart` takes a `unit`.
struct PortfolioChartSection: View {
    let store: PortfolioChartStore
    /// The user's own trades, already scoped to the selected portfolio by the
    /// screen above — a chart showing one portfolio must never carry another
    /// one's purchases.
    var trades: [TradeMark] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                RangeTabs(selected: store.range) { store.range = $0 }
                    // The row supplies its own leading inset; inside this card
                    // the padding is the card's.
                    .padding(.horizontal, -16)

                ChartToggle(
                    selected: store.mode,
                    accessibilityName: "Chart mode"
                ) { store.mode = $0 }
                .fixedSize()
            }

            ValueChart(
                points: store.points,
                state: store.state,
                granularity: store.range.granularity,
                currency: "PLN",
                excludedSymbols: store.series?.excludedSymbols ?? [],
                partialDays: store.series?.partialDays ?? 0,
                emptyMessage: store.emptyMessage,
                unit: store.mode == .percentReturn ? .percent : .money,
                mode: store.mode,
                // The change row lives INSIDE the chart, beneath this one
                // control row — never inside the `HStack` above, which must
                // stay one row on the smallest phone.
                windowLabel: store.range.windowLabel,
                trades: trades
                // No `matchOnPrice`: this line is a portfolio TOTAL (or a
                // return), and a share price has nothing to be nearest to on
                // it. Markers here place by day alone.
            )
        }
        .padding(14)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
        .accessibilityLabel("Portfolio value chart")
    }
}
