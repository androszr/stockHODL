import Foundation

/// The phone's read of `/analytics` — the same walk the web page uses.
///
/// Every figure on this payload is already folded, on Decimal, in
/// `getAnalyticsView`. This file does not add a column, does not rebase a
/// line, and does not re-sum a slice. A client that did any of those would
/// be a second opinion about what the portfolio returned.
struct AnalyticsClient: Sendable {
    let api: APIClient

    /// `portfolioId` is a FILTER, not authorization. It is re-resolved
    /// server-side against the user's own portfolios and silently falls
    /// back to All, so a stale value here shows more than the user asked
    /// for — never someone else's.
    func load(portfolioId: String?, token: String) async throws -> AnalyticsResponse {
        var query: [String: String] = [:]
        if let portfolioId { query["p"] = portfolioId }

        return try await api.decode(
            AnalyticsResponse.self,
            from: APIRequest(
                path: "/api/mobile/v1/analytics",
                query: query,
                bearerToken: token
            )
        )
    }
}
