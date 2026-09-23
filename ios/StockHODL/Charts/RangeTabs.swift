import SwiftUI

/// What a range has to offer to be a tab: a label, and a full set to draw.
///
/// The protocol exists because there are TWO range sets — the portfolio and
/// instrument charts' eight, and the options chart's five (option marks are
/// daily, so `1D`/`5D` would be tabs that always draw nothing). One generic
/// row beats two pill implementations that would drift the first time either
/// was touched.
protocol ChartRangeOption: CaseIterable, Hashable, Sendable {
    var label: String { get }
    /// The window in plain words, for the change row above the chart:
    /// "past month", "this year". Required rather than defaulted so a new
    /// range cannot ship with a blank where its name should be.
    var windowLabel: String { get }
}

extension ChartRange: ChartRangeOption {}

/// The range tabs.
///
/// Not a `Picker(.segmented)`: eight segments on a phone gives each one about
/// 40 points, and the labels would truncate before "YTD" finished. A scrolling
/// row of pills keeps every label readable and matches `range-tabs.tsx`.
struct RangeTabs<Range: ChartRangeOption>: View {
    let selected: Range
    let onSelect: (Range) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(Range.allCases), id: \.self) { range in
                    RangePill(label: range.label, isSelected: range == selected) {
                        onSelect(range)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
        }
    }
}

/// Split out of the loop above so the type checker sees one small expression
/// instead of a deeply nested modifier chain inside a `ForEach` inside a
/// `ScrollView` — the shape that makes SwiftUI compile times explode.
private struct RangePill: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    private var background: Color {
        Color(isSelected ? Tokens.accent : Tokens.surface2)
    }

    private var foreground: Color {
        Color(isSelected ? Tokens.accentContrast : Tokens.textSecondary)
    }

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(.caption, weight: .medium))
                .monospacedDigit()
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(background)
                .foregroundStyle(foreground)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        // The selected pill is distinguished by colour AND by the trait, so the
        // range in force is not carried by contrast alone.
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}
