import SwiftUI

/// What an ordering has to offer to be a menu row.
///
/// The protocol exists because there are TWO orderings — `HoldingsSort` (six)
/// and `OptionsSort` (eight, expiry first) — which the web keeps as separate
/// comparators for good reasons but renders through ONE picker
/// (`src/components/ui/sort-menu.tsx`). Same arrangement here: two
/// comparators, one control, so the two screens cannot drift in how choosing
/// an order looks or sounds.
protocol SortOption: CaseIterable, Hashable, Sendable {
    /// The menu row.
    var label: String { get }
    /// The collapsed form on the button itself.
    var short: String { get }
    /// What VoiceOver reads. The arrows in `short` are glyphs, and "Name up
    /// arrow" is not what the ordering means.
    var spoken: String { get }
}

extension HoldingsSort: SortOption {}
extension OptionsSort: SortOption {}

/// The ordering picker, shared by Holdings, the Dashboard and Options.
///
/// A `Menu` rather than a segmented control: six-to-eight orderings will not
/// fit across a phone, and the current choice has to stay readable on the
/// button itself.
struct SortMenu<Option: SortOption>: View {
    let selected: Option
    let onSelect: (Option) -> Void

    var body: some View {
        Menu {
            // A `Picker` inside a `Menu` is what puts the checkmark on the
            // current row for free, and what VoiceOver announces as a
            // single-selection group rather than N unrelated buttons.
            Picker(
                "Sort",
                selection: Binding(get: { selected }, set: onSelect)
            ) {
                ForEach(Array(Option.allCases), id: \.self) { option in
                    Text(option.label)
                        .accessibilityLabel(option.spoken)
                        .tag(option)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.caption)
                Text(selected.short)
                    .font(.caption)
            }
            .foregroundStyle(Color(Tokens.textSecondary))
            .padding(.horizontal, 10)
            // 44pt is the tap-target floor; the label is short, the target
            // is not allowed to be.
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Sort")
        .accessibilityValue(selected.spoken)
    }
}

#Preview {
    SortMenu(selected: HoldingsSort.valueDesc) { _ in }
}
