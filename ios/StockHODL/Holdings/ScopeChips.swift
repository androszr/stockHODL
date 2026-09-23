import SwiftUI

/// One entry in the scope row. "All" carries no count — it is a view of the
/// set rather than a member of it, and a number beside it would look like a
/// portfolio's.
struct ScopeChip: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let txCount: Int?
}

/// The portfolio selector: "All", one chip per portfolio, and a trailing
/// "New".
///
/// SELECTING a scope is a purely local act. Every scope already ships inside
/// the payload, so switching costs nothing and, more to the point, the client
/// never sends the server a scope to filter by — a client-supplied scope would
/// be a client-supplied query, the same rule that keeps the symbol set
/// server-derived.
///
/// MANAGING one is not local, and lives beside the chips (`ScopeManageMenu`,
/// inside `HoldingsHeaderBand`) rather than on the chips themselves: a
/// long-press menu on a pill inside a horizontal scroller is undiscoverable
/// and fights the scroll gesture, which is the same reason the web puts
/// management behind a `⋯` of its own.
///
/// Fixed-size controls may stand BESIDE this scroller as siblings, never
/// inside it — inside, a long portfolio name eats their width.
struct ScopeChips: View {
    let chips: [ScopeChip]
    let selected: String?
    let onSelect: (String) -> Void
    /// Nil hides the trailing chip entirely — which is what a screen with no
    /// portfolio store (a preview, a test) should show.
    var onCreate: (() -> Void)?
    /// The content's trailing padding. `HoldingsHeaderBand` tightens it to 4
    /// so the last chip tucks against the band's controls instead of leaving
    /// a 16pt gap; every other call site keeps the symmetric default.
    var trailingInset: CGFloat = 16

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips) { chip in
                    Chip(
                        title: chip.name,
                        isSelected: chip.id == selected,
                        action: { onSelect(chip.id) }
                    )
                }

                if let onCreate {
                    Button(action: onCreate) {
                        HStack(spacing: 4) {
                            Image(systemName: "plus")
                            Text("New")
                        }
                        .font(.footnote)
                        .foregroundStyle(Color(Tokens.textSecondary))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .overlay(
                            // Dashed, like the web's: it creates rather than
                            // selects, and must not read as a scope you are
                            // one tap away from being in.
                            Capsule().strokeBorder(
                                Color(Tokens.borderSubtle),
                                style: StrokeStyle(lineWidth: 1, dash: [4, 3])
                            )
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("New portfolio")
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, trailingInset)
            .padding(.vertical, 4)
        }
    }
}

private struct Chip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(.footnote, weight: isSelected ? .semibold : .regular))
                .foregroundStyle(Color(isSelected ? Tokens.accentContrast : Tokens.textSecondary))
                .padding(.horizontal, 14)
                // 44pt is the tap-target floor, the same one the web chips use.
                .frame(minHeight: 44)
                .background(Color(isSelected ? Tokens.accent : Tokens.surface1))
                .clipShape(Capsule())
                .overlay(
                    Capsule().stroke(
                        Color(isSelected ? Tokens.accent : Tokens.borderSubtle),
                        lineWidth: 1
                    )
                )
        }
        .buttonStyle(.plain)
        // Selection is stated, not left to the fill colour alone.
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}
