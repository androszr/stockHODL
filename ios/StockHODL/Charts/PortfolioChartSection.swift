import SwiftUI

/// The Holdings chart is disclosed below the positions heading. Its range
/// and metric controls stay on separate accessible rows when expanded.
///
/// Everything the chart shows is PLN, because the portfolio total is — the
/// series is summed server-side through the FX the engine already applied, and
/// a client that re-converted anything here would be a second money
/// implementation. In Return mode there is no currency at all: the axis is a
/// percentage, which is exactly why `ValueChart` takes a `unit`.
struct PortfolioChartSection: View {
    @State private var showsOverview: Bool
    let store: PortfolioChartStore
    /// The user's own trades, already scoped to the selected portfolio by the
    /// screen above — a chart showing one portfolio must never carry another
    /// one's purchases.
    var trades: [TradeMark] = []

    init(store: PortfolioChartStore, trades: [TradeMark] = [], initiallyExpanded: Bool = false) {
        self.store = store
        self.trades = trades
        _showsOverview = State(initialValue: initiallyExpanded)
    }

    var body: some View {
        QuietGroup {
          VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
            Button {
                showsOverview.toggle()
            } label: {
                HStack {
                    Text("Portfolio chart")
                        .font(QuietDesign.TypeRole.section)
                    Spacer()
                    Image(systemName: showsOverview ? "chevron.up" : "chevron.down")
                }
                .foregroundStyle(Color(Tokens.textPrimary))
            }
            .buttonStyle(.plain)
            .quietHitRegion()
            .accessibilityLabel(showsOverview ? "Hide portfolio chart" : "Show portfolio chart")

            if showsOverview {
                Text("Period")
                    .font(QuietDesign.TypeRole.metadata)
                    .foregroundStyle(Color(Tokens.textMuted))
                RangeTabs(selected: store.range) { store.range = $0 }
                    .padding(.horizontal, -16)

                Text("Metric")
                    .font(QuietDesign.TypeRole.metadata)
                    .foregroundStyle(Color(Tokens.textMuted))
                ChartToggle(
                    selected: store.mode,
                    accessibilityName: "Chart mode"
                ) { store.mode = $0 }

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
                windowLabel: store.range.windowLabel,
                trades: trades,
                plotHeight: 160
                // A portfolio total has no share price to match on; trade
                // markers are placed by day.
            )
            }
          }
        }
    }
}
