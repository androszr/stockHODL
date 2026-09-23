import Foundation
import Observation

/// The stories about what this portfolio holds.
///
/// One store serves both the feed and one article: they share a token, an
/// error vocabulary and — crucially — the picture cache, so an article opened
/// from a card it already loaded shows its image immediately instead of
/// fetching the same bytes a second time.
///
/// `degraded` is not an error and is never rendered as one. The loader's
/// freshest vendor refresh failed but the stored rows are still real, and a
/// caption saying they may be stale is more honest than an empty screen —
/// which would say "no news about your holdings", a different and false claim.
@Observable
@MainActor
final class NewsStore {
    private(set) var articles: [NewsItem] = []
    /// Symbols the per-request cap pushed out of the query — named on screen,
    /// because "no news for X" and "we never asked about X" look identical
    /// otherwise.
    private(set) var omitted: [String] = []
    private(set) var degraded = false

    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var hasLoaded = false

    static let genericError = "Could not load the news."

    /// The section on Watchlist shows a handful; the full screen asks for more.
    static let sectionLimit = 5
    static let listLimit = 20

    /// Freshness, shared with every other store — see `StaleState`.
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    private let client: NewsClient
    /// One cache per ticker filter — the unfiltered feed and one stock's
    /// headlines are different answers, and a shared file would let a stock
    /// page's five articles paint as the whole feed.
    private let makeCache: @Sendable (String) -> any PayloadCaching<NewsFeedResponse>
    private let tokenProvider: @MainActor () -> String?
    private let isConnected: @MainActor () -> Bool
    private let images: RemoteImageCache
    private let logos: RemoteImageCache

    init(
        client: NewsClient,
        makeCache: @escaping @Sendable (String) -> any PayloadCaching<NewsFeedResponse> = {
            DiskCache<NewsFeedResponse>(key: "news-\($0)", ttl: CacheTTL.news)
        },
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.client = client
        self.makeCache = makeCache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected

        // The fetches close over the client and the token PROVIDER, not a
        // token: a session that refreshes mid-scroll must not leave the cache
        // fetching with a dead one.
        let token = tokenProvider
        // Hero images are deliberately NOT kept on disk: an article is read
        // once and its picture is the largest thing this app downloads, so a
        // month of them would be a cache that only ever grows. Publisher marks
        // are the opposite — a dozen of them, on every article, forever — and
        // they persist for the same reason the brand icons do.
        images = RemoteImageCache(namespace: "news", disk: NoImageDisk()) { id in
            guard let bearer = await MainActor.run(body: { token() }) else { return .failed }
            return await RemoteImageOutcome.of { try await client.image(id: id, token: bearer) }
        }
        logos = RemoteImageCache(namespace: "publishers") { id in
            guard let bearer = await MainActor.run(body: { token() }) else { return .failed }
            return await RemoteImageOutcome.of { try await client.publisherLogo(id: id, token: bearer) }
        }
    }

    func load(ticker: String? = nil, limit: Int = NewsStore.listLimit) async {
        isLoading = true
        stale.connectivityChanged(to: isConnected())
        defer {
            isLoading = false
            hasLoaded = true
        }

        let cache = makeCache(ticker ?? "all")
        // Old news is not wrong news, it is just old — which is exactly the
        // kind of thing worth having on a train. The feed used to be empty
        // offline and say "Could not load the news" about articles the phone
        // had already downloaded, pictures and all.
        if articles.isEmpty, let cached = cache.read() {
            apply(cached.value)
            stale.restored(from: cached.capturedAt)
        }

        guard let token = tokenProvider() else {
            recordFailure()
            return
        }

        do {
            let feed = try await client.feed(ticker: ticker, limit: limit, token: token)
            apply(feed)
            let now = Date()
            stale.succeeded(at: now)
            cache.write(feed, at: now)
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[news] load failed: \(error)")
            #endif
            recordFailure(error)
        }
    }

    private func apply(_ feed: NewsFeedResponse) {
        articles = feed.articles
        omitted = feed.omitted
        degraded = feed.degraded
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        if articles.isEmpty {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: NewsStore.genericError
            )
        }
    }

    func article(id: String) async throws -> NewsArticleResponse {
        guard let token = tokenProvider() else { throw APIError.missingSessionToken }
        return try await client.article(id: id, token: token)
    }

    // MARK: - Pictures

    var imageLoader: RemoteImageCache { images }
    var logoLoader: RemoteImageCache { logos }

    func dismissError() {
        errorMessage = nil
    }

    func purge() {
        articles = []
        omitted = []
        degraded = false
        errorMessage = nil
        hasLoaded = false
        stale.reset()
        images.purge()
        logos.purge()
    }
}

extension NewsItem {
    /// "Reuters · 2 h ago", or just the time when the publisher is unknown.
    /// Relative rather than absolute: on a feed the age is the useful fact,
    /// and an absolute timestamp forces the reader to do the subtraction.
    var subtitle: String {
        let age = NewsItem.relativeAge(publishedAtMs)
        guard let publisherName, !publisherName.isEmpty else { return age }
        return "\(publisherName) · \(age)"
    }

    static func relativeAge(_ epochMs: Int, now: Date = Date()) -> String {
        let published = Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: published, relativeTo: now)
    }
}
