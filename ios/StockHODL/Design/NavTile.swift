import SwiftUI

/// The compact sibling of `NavRow`: icon over label, one third of a row wide.
///
/// It exists for a ROW of secondary destinations — Holdings' four
/// (Transactions, Dividends, Analytics, News) side by side, so the run-up to
/// the first holding shortens from four stacked rows to one. A solitary
/// destination (the Watchlist's News, the instrument screen's links) stays a
/// `NavRow`: a lone one-third-width tile above a grid of ticker tiles would
/// read as a stock tile with no price.
///
/// The visible label may shrink (to a 0.75 floor) or truncate at accessibility
/// text sizes; the assistive-tech label always carries the whole word, so
/// VoiceOver never speaks an abbreviation.
struct NavTile: View {
    let title: String
    let systemImage: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.subheadline)
            Text(title)
                .font(.caption2)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                // The tile row is pinned real estate on every screenful of the
                // list below it; past this cap the label stops growing rather
                // than undoing the compaction the row exists for.
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        }
        .foregroundStyle(Color(Tokens.textSecondary))
        .padding(8)
        // 64pt clears the 44pt tap-target floor with room for two lines of
        // chrome (glyph + word).
        .frame(maxWidth: .infinity, minHeight: 64)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(Tokens.surface1))
        )
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
    }
}

#Preview {
    // 375pt — the narrowest iPhone the app supports (SE 2nd/3rd gen, 13 mini).
    HStack(spacing: 8) {
        NavTile(title: "Transactions", systemImage: "list.bullet.rectangle")
        NavTile(title: "Dividends", systemImage: "banknote")
        NavTile(title: "Analytics", systemImage: "chart.xyaxis.line")
        NavTile(title: "News", systemImage: "newspaper")
    }
    .padding(.horizontal, 16)
    .frame(width: 375)
    .background(Color(Tokens.surface0))
}
