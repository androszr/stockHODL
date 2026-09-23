import Foundation

/// The news feed, one article, and the bytes behind an article's pictures.
///
/// Every image goes through OUR origin — `/api/mobile/v1/news/image/<id>` and
/// `/publisher-logo/<id>` — never a publisher host. The payload carries only
/// `hasImage` / `hasPublisherLogo` booleans and an article id; the URL itself
/// is never on the wire. That is non-negotiable #4 as it applies to assets:
/// the device makes no request the server did not mediate, and the vendor's
/// asset hosts stay unnamed on the client.
struct NewsClient: Sendable {
    let api: APIClient

    /// `ticker` narrows to one symbol. Its authorization is the server's: a
    /// symbol outside the user's own set silently returns the ordinary
    /// unfiltered feed, so this parameter is not an existence oracle.
    func feed(ticker: String?, limit: Int, token: String) async throws -> NewsFeedResponse {
        var query = ["limit": String(limit)]
        if let ticker { query["ticker"] = ticker }

        return try await api.decode(
            NewsFeedResponse.self,
            from: APIRequest(path: "/api/mobile/v1/news", query: query, bearerToken: token)
        )
    }

    func article(id: String, token: String) async throws -> NewsArticleResponse {
        try await api.decode(
            NewsArticleResponse.self,
            from: APIRequest(path: "/api/mobile/v1/news/\(id)", bearerToken: token)
        )
    }

    /// Raw bytes. A 404 here is ORDINARY — a publisher with no usable image is
    /// the common case, not a failure — and the caller renders the card
    /// without one rather than showing an error.
    func image(id: String, token: String) async throws -> Data {
        try await api.bytes(
            from: APIRequest(
                path: "/api/mobile/v1/news/image/\(id)",
                accept: "image/*",
                bearerToken: token
            )
        )
    }

    func publisherLogo(id: String, token: String) async throws -> Data {
        try await api.bytes(
            from: APIRequest(
                path: "/api/mobile/v1/news/publisher-logo/\(id)",
                accept: "image/*",
                bearerToken: token
            )
        )
    }
}
