import SwiftUI

/// A full-width row that pushes somewhere — the phone's version of the web's
/// secondary link cards.
///
/// It exists because there are several of these (News on the Watchlist, News
/// and Dividends on the instrument screen) and they light no tab. All four tab
/// slots are taken by the same four the web's `NAV` has, so every remaining
/// screen is reached from the screen it belongs beside, and they should all
/// look like the same kind of thing. Where a screen has a ROW of them —
/// Holdings' four — `NavTile` is the compact sibling that gets used instead.
struct NavRow: View {
    let title: String
    let systemImage: String
    /// The right-hand hint — a figure, a count, or nothing.
    var detail: String?

    var body: some View {
        HStack(spacing: QuietDesign.Space.small) {
            Image(systemName: systemImage)
            Text(title)
            Spacer(minLength: 0)
            if let detail {
                Text(detail)
                    .font(QuietDesign.TypeRole.metadata)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textMuted))
            }
            Image(systemName: "chevron.right")
                .font(.caption)
        }
        .font(QuietDesign.TypeRole.supporting)
        .foregroundStyle(Color(Tokens.textSecondary))
        .padding(QuietDesign.Space.group)
        .frame(minHeight: 44)
        .background(
            RoundedRectangle(cornerRadius: QuietDesign.Radius.group)
                .fill(Color(Tokens.surface1))
        )
    }
}
