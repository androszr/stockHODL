import SwiftUI

/// A two-way switch above a chart — Value / Return, Line / Candles.
///
/// A segmented control rather than the pill row `RangeTabs` uses, and the
/// difference is the point: ranges are a set you scan across, while these are
/// a choice between two readings of the same data. The two controls sit on one
/// header line and must not read as one eleven-option row.
///
/// Generic over anything with cases and a label, so the two toggles are one
/// implementation. A third would be too.
protocol ChartToggleOption: CaseIterable, Hashable, Sendable {
    var label: String { get }
}

extension ChartMode: ChartToggleOption {}
extension ChartStyle: ChartToggleOption {}

struct ChartToggle<Option: ChartToggleOption>: View {
    let selected: Option
    /// What the control is FOR, for VoiceOver — "Chart mode", "Chart style".
    /// The labels alone say Value/Return, which out of context says nothing.
    let accessibilityName: String
    let onSelect: (Option) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(Option.allCases), id: \.self) { option in
                ToggleSegment(
                    label: option.label,
                    isSelected: option == selected
                ) {
                    onSelect(option)
                }
            }
        }
        .padding(2)
        .background(Color(Tokens.surface2))
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityName)
    }
}

/// Split out for the same reason `RangePill` is: one small expression per
/// segment keeps the type checker off the deeply nested shape that makes
/// SwiftUI compile times explode.
private struct ToggleSegment: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(.caption, weight: isSelected ? .semibold : .regular))
                .foregroundStyle(Color(isSelected ? Tokens.textPrimary : Tokens.textMuted))
                .padding(.horizontal, 10)
                // 32pt inside a 36pt control. Below the 44pt floor on its own,
                // so the whole toggle carries the target: the two segments are
                // adjacent and the pair is comfortably over it in both axes —
                // the same trade the web's tab strip makes.
                .frame(minHeight: 32)
                .frame(maxWidth: .infinity)
                .background(isSelected ? Color(Tokens.surface0) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}
