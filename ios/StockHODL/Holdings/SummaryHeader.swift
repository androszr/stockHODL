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
    let summary: LiveSummary
    /// "Total value" for the holdings book; the options box says what it is.
    var title = "Total value"
    /// The box's spoken name.
    var accessibilityName = "Portfolio summary"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                total
            }

            HStack(alignment: .top, spacing: 24) {
                figure(label: "Today", value: summary.dayChange)
                figure(label: "Total", value: summary.totalChange)
            }

            if !summary.excludedSymbols.isEmpty {
                // Naming them beats a count: the user can tell at a glance
                // whether the omission matters to them.
                note("Not included (no price): \(summary.excludedSymbols.joined(separator: ", "))")
            }
            if summary.partialDayChange {
                note("Today's change — both the amount and the percentage — omits positions without day-change data.")
            }

            // The whole book's five-session lights, along the bottom edge
            // like every tile's — the summed value, not one price
            // (2026-09-21). Reserved-but-blank when the server sent none.
            // `.ignore`, not a bare label: the lights hide their own bars
            // from VoiceOver, so the row must be its own element to be read.
            TrendLights(days: summary.trend)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Self.trendLabel(summary.trend))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
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
        // The server sends "23 708,11 PLN" as one string; splitting it lets the
        // currency sit smaller without reformatting the number, which would
        // mean parsing money on the client.
        let split = splitMoney(summary.totalValue ?? "—")
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(split.amount)
                .font(.system(.title2, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Color(Tokens.textPrimary))
            Text(split.currency)
                .font(.footnote)
                .foregroundStyle(Color(Tokens.textMuted))
        }
    }

    private func figure(label: String, value: LiveFigure?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            // A null figure is muted, not coloured: "—" has no direction, and
            // painting it neutral-green would imply one.
            Text(value?.text ?? "—")
                .font(.system(.subheadline, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(Color(value.map(\.direction.token) ?? Tokens.textMuted))
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(Color(Tokens.textMuted))
    }
}
