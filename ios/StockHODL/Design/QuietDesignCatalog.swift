import SwiftUI

/// Local Xcode preview catalog. Every figure is synthetic and already formatted.
struct QuietDesignCatalog: View {
    @State private var range: ChartRange = .oneMonth

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: QuietDesign.Space.section) {
                Text("Quiet Precision")
                    .font(QuietDesign.TypeRole.screen)
                    .foregroundStyle(Color(Tokens.textPrimary))
                QuietGroup {
                    VStack(alignment: .leading, spacing: QuietDesign.Space.medium) {
                        Text("All portfolios · holdings")
                            .font(QuietDesign.TypeRole.supporting)
                            .foregroundStyle(Color(Tokens.textMuted))
                        QuietFinancialValue(text: "1 234 567 890,12 PLN", prominent: true)
                        QuietLabeledFigure(label: "Today", value: "+12 340,56 PLN", direction: .gain)
                        QuietLabeledFigure(label: "Total P/L", value: "−8 765,43 PLN", direction: .loss)
                        Text("Partial: figures exclude ABC")
                            .font(QuietDesign.TypeRole.metadata)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                }
                QuietSectionHeading(title: "Controls")
                RangeTabs(selected: range) { range = $0 }
                    .padding(.horizontal, -QuietDesign.Space.page)
                Button("Selected action") {}
                    .font(QuietDesign.TypeRole.body)
                    .foregroundStyle(Color(Tokens.accentContrast))
                    .padding(.horizontal, QuietDesign.Space.group)
                    .quietHitRegion()
                    .background(Color(Tokens.accent), in: RoundedRectangle(cornerRadius: QuietDesign.Radius.control))
                QuietSectionHeading(title: "Stock row")
                TickerTile(
                    symbol: "ACME",
                    displayName: "A long example company name that should wrap",
                    price: "123 456,78 USD",
                    cachedPrice: nil,
                    dayPct: nil,
                    extended: nil,
                    unrealizedPct: "+12,34%",
                    direction: .gain
                )
                EmptyState(title: "Nothing here yet", explanation: "A readable empty state keeps its action reachable.", showsStill: false)
            }
            .padding(QuietDesign.Space.page)
        }
        .background(Color(Tokens.surface0))
    }
}

#Preview("Quiet Precision · dark") {
    QuietDesignCatalog().preferredColorScheme(.dark)
}

#Preview("Quiet Precision · light") {
    QuietDesignCatalog().preferredColorScheme(.light)
}

#Preview("Quiet Precision · accessibility") {
    QuietDesignCatalog()
        .preferredColorScheme(.dark)
        .environment(\.dynamicTypeSize, .accessibility2)
}
