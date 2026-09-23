import Foundation

/// Portfolio management — the four writes the web keeps behind the `⋯` menu
/// on the scope chips.
///
/// There is no READ here on purpose. The chip row is built from the bootstrap
/// payload the Holdings screen already holds, so a second list endpoint would
/// give the app two answers to "what are my portfolios" that could disagree
/// mid-scroll. After a write the caller refreshes the ONE source.
struct PortfoliosClient: Sendable {
    let api: APIClient

    /// Answers with the new id, so the caller can select the scope it just
    /// made rather than guessing which of two same-named chips is the new one.
    func create(name: String, token: String) async throws -> String {
        try await api.decode(
            PortfolioCreated.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/portfolios",
                body: try JSONEncoder().encode(PortfolioNameRequest(name: name)),
                bearerToken: token
            )
        ).id
    }

    func rename(id: String, to name: String, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "PATCH",
                path: "/api/mobile/v1/portfolios/\(id)",
                body: try JSONEncoder().encode(PortfolioNameRequest(name: name)),
                bearerToken: token
            )
        )
    }

    /// The FULL id list in the order the user wants, never a delta. The server
    /// refuses a stale or partial list rather than patching it — holes and ties
    /// in `sortOrder` are worse than an error the client can retry.
    func reorder(ids: [String], token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/portfolios/reorder",
                body: try JSONEncoder().encode(PortfolioReorderRequest(ids: ids)),
                bearerToken: token
            )
        )
    }

    /// Destructive: the FK cascade takes this portfolio's transactions with
    /// it. The confirmation, with the row count, is the caller's job.
    func delete(id: String, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "DELETE",
                path: "/api/mobile/v1/portfolios/\(id)",
                bearerToken: token
            )
        )
    }
}

/// `portfolioCreateSchema` and `portfolioRenameSchema` — the same one-field
/// body, so one struct. Hand-written like every other request shape: the
/// server schema carries a trim the client never sends the result of.
struct PortfolioNameRequest: Encodable, Sendable, Equatable {
    let name: String
}

/// `portfolioReorderSchema`.
struct PortfolioReorderRequest: Encodable, Sendable, Equatable {
    let ids: [String]
}
