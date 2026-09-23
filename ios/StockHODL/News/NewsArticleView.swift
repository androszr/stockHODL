import SwiftUI

/// One story — the phone's half of `/news/[id]`.
///
/// The full text is NOT here and never will be: this app stores a headline, a
/// description and a link, and the article belongs to its publisher. The
/// primary action is opening it in Safari, which is also what keeps this
/// screen honest about whose words these are.
struct NewsArticleView: View {
    let store: NewsStore
    let id: String

    @State private var article: NewsArticleResponse?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle("Story")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: id) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if let article {
            detail(article)
        } else if failed {
            VStack(spacing: 12) {
                Text("Couldn't load that story.")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textSecondary))
                Button("Try again") { Task { await load() } }
                    .foregroundStyle(Color(Tokens.accent))
            }
            .padding(24)
        } else {
            ProgressView().tint(Color(Tokens.textMuted))
        }
    }

    private func detail(_ article: NewsArticleResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if article.hasImage {
                    NewsImage(id: article.id, loader: store.imageLoader, contentMode: .fill) {
                        Color(Tokens.surface2)
                    }
                    .frame(height: 180)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                Text(article.title)
                    .font(.system(.title3, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))

                Text(byline(article))
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))

                if let description = article.description, !description.isEmpty {
                    Text(description)
                        .font(.subheadline)
                        .foregroundStyle(Color(Tokens.textSecondary))
                }

                if let url = URL(string: article.articleUrl) {
                    Link(destination: url) {
                        Label("Read at \(article.publisherName ?? "the publisher")", systemImage: "safari")
                            .font(.system(.subheadline, weight: .medium))
                    }
                    .foregroundStyle(Color(Tokens.accent))
                }

                if !article.tickers.isEmpty {
                    tickers(article)
                }

                if !article.insights.isEmpty {
                    insights(article)
                }
            }
            .padding(16)
        }
    }

    private func byline(_ article: NewsArticleResponse) -> String {
        var parts: [String] = []
        if let publisherName = article.publisherName, !publisherName.isEmpty {
            parts.append(publisherName)
        }
        if let author = article.author, !author.isEmpty { parts.append(author) }
        parts.append(NewsItem.relativeAge(article.publishedAtMs))
        return parts.joined(separator: " · ")
    }

    /// Only `linkableTickers` become taps. The rest are plain text, because
    /// the instrument screen resolves against the user's OWN symbols and a
    /// link that lands nowhere is worse than no link — the same rule the web
    /// page follows.
    private func tickers(_ article: NewsArticleResponse) -> some View {
        let linkable = Set(article.linkableTickers)
        return VStack(alignment: .leading, spacing: 6) {
            Text("Mentioned")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            // The existing wrapping layout, the one the option card's
            // headline row uses — a horizontal scroller would hide tickers
            // off the right edge, and on a list of what a story mentions the
            // hidden ones are exactly what matters.
            FlowRow(spacing: 6, lineSpacing: 6) {
                ForEach(article.tickers, id: \.self) { ticker in
                    if linkable.contains(ticker) {
                        NavigationLink(value: Route.instrument(ticker)) {
                            chip(ticker, tappable: true)
                        }
                        .buttonStyle(.plain)
                    } else {
                        chip(ticker, tappable: false)
                    }
                }
            }
        }
    }

    private func insights(_ article: NewsArticleResponse) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Vendor sentiment")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            ForEach(article.insights, id: \.ticker) { insight in
                // The vendor's word verbatim, never mapped onto this app's
                // gain/loss colours: a sentiment label is somebody else's
                // opinion and must not read as this portfolio's own signal.
                Text("\(insight.ticker) — \(insight.sentiment ?? "no view")")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textSecondary))
            }
        }
    }

    private func chip(_ text: String, tappable: Bool) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(Color(tappable ? Tokens.accent : Tokens.textSecondary))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(Tokens.surface2))
            .clipShape(Capsule())
    }

    private func load() async {
        failed = false
        do {
            article = try await store.article(id: id)
        } catch {
            #if DEBUG
                print("[news] article failed: \(error)")
            #endif
            if article == nil { failed = true }
        }
    }
}
