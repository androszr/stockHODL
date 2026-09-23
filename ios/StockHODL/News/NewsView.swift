import SwiftUI

/// The fuller news list — the phone's half of `/news`.
///
/// `ticker` narrows it to one of the user's own symbols, exactly as
/// `?ticker=` does on the web. The narrowing is not enforced here: the server
/// re-validates the symbol against the user's own sources and silently serves
/// the unfiltered feed for anything else, so this screen cannot be pointed at
/// a stock the user does not hold.
struct NewsView: View {
    let store: NewsStore
    var ticker: String?

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle(ticker.map { "\($0) news" } ?? "News")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load(ticker: ticker) }
        .alert(
            store.errorMessage ?? "",
            isPresented: .init(
                get: { store.errorMessage != nil && !store.articles.isEmpty },
                set: { if !$0 { store.dismissError() } }
            )
        ) {
            Button("OK") { store.dismissError() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.articles.isEmpty {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.articles.isEmpty {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.load(ticker: ticker) }
            }
        } else if store.hasLoaded, store.articles.isEmpty {
            EmptyState(
                title: "No stories right now",
                explanation: "Coverage of your holdings appears here as it's published."
            )
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                StaleBar(freshness: store.freshness)

                // Both captions are disclosures, not errors, and both render
                // ABOVE the stories so they are read before the list is
                // trusted.
                if store.degraded {
                    caption("These may be out of date — the last refresh didn't get through.")
                }
                if !store.omitted.isEmpty {
                    caption("Not searched this time: \(store.omitted.joined(separator: ", ")).")
                }

                ForEach(store.articles, id: \.id) { item in
                    NavigationLink(value: Route.newsArticle(item.id)) {
                        NewsCard(
                            item: item,
                            imageLoader: store.imageLoader,
                            logoLoader: store.logoLoader
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .refreshable { await store.load(ticker: ticker) }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(Color(Tokens.textMuted))
            .padding(.bottom, 2)
    }
}
