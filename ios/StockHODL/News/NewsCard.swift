import SwiftUI

/// One story — the native half of `article-card.tsx`.
///
/// The matched tickers are the reason this article is here at all, so they are
/// shown rather than implied: a feed of general market news with no visible
/// connection to the portfolio is indistinguishable from a feed that has
/// stopped filtering.
struct NewsCard: View {
    let item: NewsItem
    let imageLoader: RemoteImageCache
    let logoLoader: RemoteImageCache

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    if item.hasPublisherLogo {
                        NewsImage(id: item.id, loader: logoLoader, contentMode: .fit) {
                            Color.clear
                        }
                        .frame(width: 14, height: 14)
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    Text(item.subtitle)
                        .font(.caption2)
                        .foregroundStyle(Color(Tokens.textMuted))
                        .lineLimit(1)
                }

                Text(item.title)
                    .font(.system(.subheadline, weight: .medium))
                    .foregroundStyle(Color(Tokens.textPrimary))
                    .multilineTextAlignment(.leading)
                    .lineLimit(3)

                if !item.matchedTickers.isEmpty {
                    Text(item.matchedTickers.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(Color(Tokens.textSecondary))
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            // Space is reserved ONLY when an image exists, so a feed of
            // image-less stories does not carry a column of grey boxes.
            if item.hasImage {
                NewsImage(id: item.id, loader: imageLoader, contentMode: .fill) {
                    Color(Tokens.surface2)
                }
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }
}
