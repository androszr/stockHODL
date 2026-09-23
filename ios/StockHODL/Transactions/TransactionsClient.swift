import Foundation

/// Everything the transaction screens talk to.
///
/// Four writes and three reads, all under `/api/mobile/v1/`. The writes carry
/// an `Origin` header — `APIClient` adds it — because the mobile routes refuse
/// an unsafe method whose origin is not this app's own.
struct TransactionsClient: Sendable {
    let api: APIClient

    // MARK: - Reads

    /// The list. `symbol` narrows it to one instrument, which is what the
    /// instrument screen needs and why there is no second endpoint for it.
    func list(symbol: String? = nil, portfolioId: String? = nil, token: String) async throws -> [TransactionRow] {
        var query: [String: String] = [:]
        if let symbol { query["symbol"] = symbol }
        if let portfolioId { query["portfolioId"] = portfolioId }

        return try await api.decode(
            TransactionList.self,
            from: APIRequest(path: "/api/mobile/v1/transactions", query: query, bearerToken: token)
        ).transactions
    }

    func portfolios(token: String) async throws -> [Portfolio] {
        try await api.decode(
            PortfolioList.self,
            from: APIRequest(path: "/api/mobile/v1/portfolios", bearerToken: token)
        ).portfolios
    }

    /// The combobox. Answers `degraded: true` only when the vendor failed AND
    /// the local directory had nothing — which is the one case where telling
    /// the user to type the ticker in themselves is the truth.
    func searchSymbols(_ query: String, token: String) async throws -> SymbolSearchResponse {
        try await api.decode(
            SymbolSearchResponse.self,
            from: APIRequest(
                path: "/api/mobile/v1/symbols/search",
                query: ["q": query],
                bearerToken: token
            )
        )
    }

    /// The D-1 NBP rate for the trade date (art. 11a PIT/CIT).
    ///
    /// A refusal comes back 200 with `ok: false` rather than a status code:
    /// "not published yet" and "vendor down" are facts the form acts on
    /// differently, and a transport error could express neither.
    func fxRate(currency: Currency, tradeDate: String, token: String) async throws -> FxRateResponse {
        try await api.decode(
            FxRateResponse.self,
            from: APIRequest(
                path: "/api/mobile/v1/fx-rate",
                query: ["currency": currency.rawValue, "tradeDate": tradeDate],
                bearerToken: token
            )
        )
    }

    // MARK: - Writes

    func create(_ body: TransactionRequest, token: String) async throws -> String {
        try await api.decode(
            TransactionCreated.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/transactions",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        ).id
    }

    /// The instrument is LOCKED on edit: the stored symbol and currency are
    /// submitted along with the editable fields and the server refuses a
    /// mismatch rather than rebinding. Changing the instrument is a different
    /// trade, and the honest path is delete plus re-add.
    func update(id: String, _ body: TransactionRequest, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "PATCH",
                path: "/api/mobile/v1/transactions/\(id)",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    func delete(id: String, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "DELETE",
                path: "/api/mobile/v1/transactions/\(id)",
                bearerToken: token
            )
        )
    }
}
