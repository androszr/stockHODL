import SwiftUI

/// The instrument screen's two actions — watch this stock, and add a
/// transaction for it — as a compact pair of 44pt icon buttons at the right
/// end of the price line.
///
/// In-page, deliberately, after two other homes failed. A full-width row of
/// labelled buttons under the chart was cramped against the range tabs above
/// and the position panel below on a phone-width screen (the audit's record,
/// kept here so that layout is not reinvented). The nav-bar `+` menu that
/// replaced it was drawn into a toolbar the app hides on every pushed screen
/// (`hidesSystemNav()`), so both actions were unreachable. And the persistent
/// top bar cannot host them: it sits outside every `NavigationStack`, so it
/// could show a button but never the watch toggle's on/off state.

/// The watch button's decision — glyph, announcement, and when it is
/// inactive — kept UI-free so the test target exercises it without mounting
/// SwiftUI, the `TopBarAdd.current` precedent.
///
/// State is never carried by the picture alone: the glyph variant and the
/// accessibility value change TOGETHER, and the button disables while a
/// toggle is in flight so an optimistic tap cannot re-fire mid-save.
struct WatchActionModel: Equatable {
    let systemImage: String
    let accessibilityValue: String
    let isDisabled: Bool

    static func current(isWatched: Bool, isToggling: Bool) -> WatchActionModel {
        WatchActionModel(
            systemImage: isWatched ? "binoculars.fill" : "binoculars",
            accessibilityValue: isWatched ? "Watching" : "Not watching",
            isDisabled: isToggling
        )
    }
}

/// The 44pt pair itself, rendered from the model. Icons carry the accent
/// color for both states — direction of the toggle is the glyph variant plus
/// the accessibility value, never a color.
struct InstrumentActionButtons: View {
    let model: WatchActionModel
    /// The add button renders only where the prefilled form can exist —
    /// previews and tests construct the screen without a network and must
    /// keep doing so.
    let showsAddTransaction: Bool
    let onToggleWatch: () -> Void
    let onAddTransaction: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onToggleWatch) {
                Image(systemName: model.systemImage)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color(Tokens.accent))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .disabled(model.isDisabled)
            .accessibilityLabel("Watch")
            .accessibilityValue(model.accessibilityValue)

            if showsAddTransaction {
                Button(action: onAddTransaction) {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color(Tokens.accent))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Add a transaction")
            }
        }
    }
}
