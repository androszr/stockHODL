import SwiftUI

/// Total value, day change, total change — and, when it applies, the admission
/// that the day change is incomplete.
///
/// Laid out like `src/components/holdings/portfolio-summary.tsx`: every figure
/// sits UNDER its own label. An earlier native version put "Day" and "Total"
/// inline beside their numbers, which saved a line and cost the thing the
/// labels are for — two signed percentages side by side with no visible
/// heading are indistinguishable at a glance.
///
/// `partialDayChange` and `excludedSymbols` are the honest part. When a symbol
/// has no usable prior close, the server excludes it from the day figure rather
/// than pretending it moved zero, and says so. Dropping that here would turn a
/// carefully qualified number into a confident wrong one.
struct SummaryHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showsTrend = false
    let summary: LiveSummary
    /// "Total value" for the holdings book; the options box says what it is.
    var title = "Total value"
    /// The box's spoken name.
    var accessibilityName = "Portfolio summary"

    var body: some View {
        VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(QuietDesign.TypeRole.supporting)
                    .foregroundStyle(Color(Tokens.textMuted))
                total
            }

            if dynamicTypeSize.isAccessibilitySize {
              VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                figure(label: "Today", value: summary.dayChange)
                figure(label: "Total P/L", value: summary.totalChange)
              }
            } else {
              HStack(alignment: .top, spacing: QuietDesign.Space.section) {
                figure(label: "Today", value: summary.dayChange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                figure(label: "Total P/L", value: summary.totalChange)
                    .frame(maxWidth: .infinity, alignment: .leading)
              }
            }

            if !summary.excludedSymbols.isEmpty {
                // Naming them beats a count: the user can tell at a glance
                // whether the omission matters to them.
                note("Not included (no price): \(summary.excludedSymbols.joined(separator: ", "))")
            }
            if summary.partialDayChange {
                note("Today's change — both the amount and the percentage — omits positions without day-change data.")
            }

            Button {
                showsTrend.toggle()
            } label: {
                HStack(spacing: QuietDesign.Space.small) {
                    Text("Last 5 sessions")
                    Image(systemName: showsTrend ? "chevron.up" : "chevron.down")
                }
                .font(QuietDesign.TypeRole.metadata)
                .foregroundStyle(Color(Tokens.textMuted))
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .accessibilityLabel(showsTrend ? "Hide last five sessions" : "Show last five sessions")
            if showsTrend {
                TrendLights(days: summary.trend)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Self.trendLabel(summary.trend))
            }
        }
        .padding(.vertical, QuietDesign.Space.small)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityName)
    }

    /// The strip's spoken sentence, or "no five-day trend" when it is blank —
    /// so the row is never a silent swipe stop.
    nonisolated static func trendLabel(_ days: [TrendDay?]?) -> String {
        let phrase = TrendLights.phrase(for: days)
        return phrase.isEmpty ? "No five-day trend" : String(phrase.dropFirst(2))
    }

    private var total: some View {
        QuietFinancialValue(text: summary.totalValue ?? "—", prominent: true)
    }

    private func figure(label: String, value: LiveFigure?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            // A null figure is muted, not coloured: "—" has no direction, and
            // painting it neutral-green would imply one.
            QuietFinancialValue(text: value?.text ?? "—", direction: value?.direction)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(QuietDesign.TypeRole.metadata)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(Color(Tokens.textMuted))
    }
}
