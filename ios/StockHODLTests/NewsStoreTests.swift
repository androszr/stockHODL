import Foundation
import Testing

@testable import StockHODL

private final class FakeNewsServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var feedCalls = 0
    private(set) var imageCalls = 0
    private(set) var lastQuery: String?

    var feed = NewsFeedResponse(
        articles: [NewsFixture.item()],
        degraded: false,
        omitted: []
    )
    var feedFailure: Int?
    /// Bytes the image route answers with; nil means 404 — the ORDINARY case
    /// for a publisher with no usable picture.
    var imageBytes: Data? = NewsFixture.pngBytes()

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path ?? ""

            if path.contains("/news/image/") || path.contains("/publisher-logo/") {
                let bytes = lock.withLock { () -> Data? in
                    imageCalls += 1
                    return imageBytes
                }
                let http = HTTPURLResponse(
                    url: request.url!,
                    statusCode: bytes == nil ? 404 : 200,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (bytes ?? Data(), http)
            }

            let status = lock.withLock { () -> Int in
                feedCalls += 1
                lastQuery = request.url?.query
                return feedFailure ?? 200
            }
            let body = status == 200
                ? try JSONEncoder().encode(lock.withLock { feed })
                : Data(#"{"error":"nope"}"#.utf8)
            let http = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!
            return (body, http)
        }
    }
}

private enum NewsFixture {
    static func item(
        id: String = "abc123",
        publisherName: String? = "Reuters",
        hasImage: Bool = true,
        matchedTickers: [String] = ["AAPL"]
    ) -> NewsItem {
        NewsItem(
            hasImage: hasImage,
            hasPublisherLogo: true,
            id: id,
            matchedTickers: matchedTickers,
            publishedAtMs: 1_771_000_000_000,
            publisherName: publisherName,
            title: "Apple ships something"
        )
    }

    /// A one-pixel PNG — real bytes, so `UIImage` actually decodes them.
    static func pngBytes() -> Data {
        Data(
            base64Encoded:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        )!
    }
}

@MainActor
private func makeStore(
    _ server: FakeNewsServer,
    token: String? = "signed.token",
    caches: FakePayloadCacheFamily<NewsFeedResponse> = FakePayloadCacheFamily<NewsFeedResponse>(),
    connected: Bool = true
) -> NewsStore {
    NewsStore(
        client: NewsClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        // In memory, never the real Caches directory — see `FakeCaches`.
        makeCache: caches.make(),
        tokenProvider: { token },
        isConnected: { connected }
    )
}

@Suite("News store")
@MainActor
struct NewsStoreTests {
    @Test("the feed loads with its disclosures intact")
    func loadsFeed() async {
        let server = FakeNewsServer()
        server.feed = NewsFeedResponse(
            articles: [NewsFixture.item()],
            degraded: true,
            omitted: ["TSLA"]
        )
        let store = makeStore(server)

        await store.load()

        #expect(store.articles.count == 1)
        // Neither of these is an error and neither may be swallowed: stale
        // rows with a caption beat an empty screen, and an unsearched symbol
        // must not look like a symbol with no news.
        #expect(store.degraded)
        #expect(store.omitted == ["TSLA"])
        #expect(store.errorMessage == nil)
    }

    @Test("a ticker filter travels to the server rather than filtering here")
    func sendsTicker() async {
        let server = FakeNewsServer()
        let store = makeStore(server)

        await store.load(ticker: "AAPL")

        // The server re-validates it against the user's own symbols and
        // silently widens for anything else, which is what stops this
        // parameter being an existence oracle.
        #expect(server.lastQuery?.contains("ticker=AAPL") == true)
    }

    @Test("a failed refresh keeps the stories already on screen")
    func keepsArticlesOnRefreshFailure() async {
        let server = FakeNewsServer()
        let store = makeStore(server)
        await store.load()

        server.feedFailure = 500
        await store.load()

        #expect(store.articles.count == 1)
        #expect(store.errorMessage == nil)
    }

    @Test("a failed first load says so")
    func reportsFirstFailure() async {
        let server = FakeNewsServer()
        server.feedFailure = 500
        let store = makeStore(server)

        await store.load()

        // A 500 is the server, not the radio — the generic sentence stands.
        #expect(store.errorMessage == NewsStore.genericError)
    }

    @Test("the feed is cached per ticker, so a stock's headlines are not the whole feed")
    func cachedPerTicker() async {
        let caches = FakePayloadCacheFamily<NewsFeedResponse>()
        let server = FakeNewsServer()
        let store = makeStore(server, caches: caches)

        await store.load(ticker: "AAPL")

        #expect(caches.keys == ["AAPL"])
    }

    @Test("pictures are fetched once and served from memory afterwards")
    func cachesImages() async {
        let server = FakeNewsServer()
        let store = makeStore(server)

        #expect(await store.imageLoader.image(for: "abc123") != nil)
        #expect(await store.imageLoader.image(for: "abc123") != nil)

        #expect(server.imageCalls == 1)
        // A synchronous hit is what lets a scrolled-back card paint opaque on
        // its first frame instead of fading in again.
        #expect(store.imageLoader.cached("abc123") != nil)
    }

    @Test("a missing picture is remembered as missing")
    func cachesImageMisses() async {
        let server = FakeNewsServer()
        server.imageBytes = nil
        let store = makeStore(server)

        #expect(await store.imageLoader.image(for: "abc123") == nil)
        #expect(await store.imageLoader.image(for: "abc123") == nil)

        // Publishers with no usable image are the common case, not a failure.
        // Without the negative set every scroll re-asks for the same 404.
        #expect(server.imageCalls == 1)
    }

    @Test("no token means no request at all")
    func withoutToken() async {
        let server = FakeNewsServer()
        let store = makeStore(server, token: nil)

        await store.load()

        #expect(server.feedCalls == 0)
    }

    @Test("sign-out clears the pictures as well as the rows")
    func purges() async {
        let server = FakeNewsServer()
        let store = makeStore(server)
        await store.load()
        _ = await store.imageLoader.image(for: "abc123")

        store.purge()

        #expect(store.articles.isEmpty)
        // Pictures are not secret, but a screen still holding the previous
        // session's images makes a purge look like it did not happen.
        #expect(store.imageLoader.cached("abc123") == nil)
    }
}

@Suite("News card")
struct NewsItemTests {
    @Test("the subtitle names the publisher when there is one")
    func subtitleWithPublisher() {
        #expect(NewsFixture.item().subtitle.hasPrefix("Reuters · "))
    }

    @Test("an unknown publisher leaves the age standing alone")
    func subtitleWithoutPublisher() {
        let bare = NewsFixture.item(publisherName: nil).subtitle
        // Never a stray separator, and never the word "Unknown" — the age is
        // the useful fact and it can carry the line by itself.
        #expect(!bare.contains("·"))
        #expect(!bare.isEmpty)
    }

    @Test("an empty publisher name is treated as no publisher")
    func subtitleWithEmptyPublisher() {
        #expect(!NewsFixture.item(publisherName: "").subtitle.contains("·"))
    }
}
