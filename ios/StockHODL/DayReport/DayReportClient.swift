import Foundation

struct DayReportClient: Sendable {
    let api: APIClient

    func load(day: String?, kind: DayReportKind, portfolioId: String?, token: String) async throws -> DayReportResponse {
        var query = ["kind": kind.rawValue]
        if let day { query["day"] = day }
        if let portfolioId { query["p"] = portfolioId }
        return try await api.decode(
            DayReportResponse.self,
            from: APIRequest(path: "/api/mobile/v1/day-report", query: query, bearerToken: token)
        )
    }

    func generateNarrative(day: String, kind: DayReportKind, portfolioId: String?, token: String) async throws -> DayReportNarrativeResponse {
        let body = NarrativeRequest(day: day, kind: kind.rawValue, p: portfolioId)
        return try await api.decode(
            DayReportNarrativeResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/day-report/narrative",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    /// The Dashboard's history: page one with no cursor, older pages with the
    /// `nextCursor` the previous answer carried.
    func history(cursor: String?, token: String) async throws -> DayReportHistoryResponse {
        var query: [String: String] = [:]
        if let cursor { query["cursor"] = cursor }
        return try await api.decode(
            DayReportHistoryResponse.self,
            from: APIRequest(path: "/api/mobile/v1/day-report/history", query: query, bearerToken: token)
        )
    }

    private struct NarrativeRequest: Encodable {
        let day: String
        let kind: String
        let p: String?
    }
}

extension DayReportStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> DayReportStore {
        DayReportStore(
            client: DayReportClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}
