import SwiftUI

/// The Holdings screen's pinned strip: the scope chips, the ordering control,
/// and — with a portfolio selected — the management menu, on ONE line.
///
/// It is "sticky" by construction, not by modifier: it sits in the fixed
/// `VStack` ABOVE the `ScrollView`, exactly where `ScopeChips` sat before.
/// No safe-area-inset trick, no pinned section header — both would put the band
/// inside the refreshable scroll view, where a pull that starts on the band
/// either steals the chips' horizontal drag or drags the band down with the
/// spinner.
///
/// The sort control shares a line with the chips ONLY because it lives
/// OUTSIDE the horizontal `ScrollView`, as a fixed-size sibling: SwiftUI
/// hands the fixed-size children their ideal width first and the scroller
/// takes the remainder, so the chips can never squeeze the controls. The old
/// rule still holds for anything placed INSIDE `ScopeChips` — a control in
/// there fights the scroll gesture and gets eaten by long portfolio names.
struct HoldingsHeaderBand: View {
    let chips: [ScopeChip]
    let selected: String?
    let onSelect: (String) -> Void
    /// Nil hides the trailing "New" chip — a preview or test with no
    /// portfolio store.
    var onCreate: (() -> Void)?

    let sort: HoldingsSort
    let onSort: (HoldingsSort) -> Void

    /// The selected portfolio, when management should show; nil renders no
    /// "⋯" at all — the "All" view carries no management chrome, and neither
    /// does a screen built from a fake `LiveStore` with no portfolio store.
    var manageScope: ScopeChip?
    var ordered: [String] = []
    var isBusy: Bool = false
    var onRename: () -> Void = {}
    var onMove: (Int) -> Void = { _ in }
    var onDelete: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                // The ONLY flexible child. Its viewport is computed as the
                // remainder after the fixed controls take their ideal width —
                // never give it a fixed frame, and never give the controls
                // `maxWidth: .infinity`, or the squeeze comes back.
                ScopeChips(
                    chips: chips,
                    selected: selected,
                    onSelect: onSelect,
                    onCreate: onCreate,
                    trailingInset: 4
                )

                HStack(spacing: 0) {
                    // A visual terminator between the scrolling names and the
                    // fixed controls — not a layout guarantee.
                    Rectangle()
                        .fill(Color(Tokens.borderSubtle))
                        .frame(width: 1, height: 24)
                        .padding(.horizontal, 4)

                    SortMenu(selected: sort, onSelect: onSort)

                    if let manageScope {
                        ScopeManageMenu(
                            scope: manageScope,
                            ordered: ordered,
                            isBusy: isBusy,
                            onRename: onRename,
                            onMove: onMove,
                            onDelete: onDelete
                        )
                    }
                }
                .padding(.trailing, 12)
                // The band is pinned, so its height is paid on every
                // screenful. These caps are applied HERE, by the parent —
                // `SortMenu` is shared with the Dashboard and Options, whose
                // in-scroll copies keep scaling freely.
                .lineLimit(1)
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            }
            .background(Color(Tokens.surface0))

            Rectangle()
                .fill(Color(Tokens.borderSubtle))
                .frame(height: 1)
        }
    }
}

#Preview {
    HoldingsHeaderBand(
        chips: [
            ScopeChip(id: "all", name: "All", txCount: nil),
            ScopeChip(id: "p1", name: "IKE", txCount: 12),
            ScopeChip(id: "p2", name: "A rather long portfolio name indeed", txCount: 3),
        ],
        selected: "p1",
        onSelect: { _ in },
        onCreate: {},
        sort: .valueDesc,
        onSort: { _ in },
        manageScope: ScopeChip(id: "p1", name: "IKE", txCount: 12),
        ordered: ["p1", "p2"]
    )
    .frame(width: 375)
    .background(Color(Tokens.surface0))
}
