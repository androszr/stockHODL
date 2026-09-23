import Foundation

/// Every dividend the ledger has recorded, plus the four writes.
///
/// The writes go to the SAME `src/lib/dividends/mutations.ts` the web's Server
/// Actions call, over the same isomorphic validation schema — so there is one
/// implementation of a record the user may file taxes from, not two that agree
/// until they do not. The store's overwrite-protection rule (a refresh never
/// touches an edited or manual row) is enforced server-side and needs nothing
/// from this file.
struct DividendsClient: Sendable {
    let api: APIClient

    /// `portfolioId` and `symbol` are FILTERS, not authorization. Both are
    /// re-resolved server-side against the user's own rows and silently fall
    /// back to the unfiltered list, so a stale value here shows more than the
    /// user asked for — never someone else's.
    func load(
        portfolioId: String?,
        symbol: String?,
        token: String
    ) async throws -> DividendsResponse {
        var query: [String: String] = [:]
        if let portfolioId { query["p"] = portfolioId }
        if let symbol { query["symbol"] = symbol }

        return try await api.decode(
            DividendsResponse.self,
            from: APIRequest(
                path: "/api/mobile/v1/dividends",
                query: query,
                bearerToken: token
            )
        )
    }

    /// What a manual payment may attach to: the user's own transacted
    /// instruments and their portfolios, as one read — the form needs both
    /// before it can render at all.
    func formOptions(token: String) async throws -> DividendInstrumentList {
        try await api.decode(
            DividendInstrumentList.self,
            from: APIRequest(path: "/api/mobile/v1/dividends/instruments", bearerToken: token)
        )
    }

    /// Re-ask the vendor now. Always answers 200: the sync is best-effort end
    /// to end, so "the vendor did not answer" and "nothing new" are the same
    /// outcome from here — the caller reloads and sees whatever landed.
    func refresh(token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/dividends/refresh",
                bearerToken: token
            )
        )
    }

    func create(_ body: DividendCreateRequest, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/dividends",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    /// The instrument and the currency are LOCKED on edit — a different
    /// company or currency is a different payment, the transaction
    /// instrument-lock precedent. Delete plus re-add is the path.
    func update(id: String, _ body: DividendUpdateRequest, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "PATCH",
                path: "/api/mobile/v1/dividends/\(id)",
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
                path: "/api/mobile/v1/dividends/\(id)",
                bearerToken: token
            )
        )
    }
}

/// `dividendCreateSchema` in `src/lib/dividends/validation.ts`.
///
/// Hand-written like every other request shape, and the OPTIONALS matter: the
/// server preprocesses an empty string to "absent", but it does NOT accept
/// `null` for these fields. Swift's `JSONEncoder` omits a nil optional, which
/// is exactly the encoding the schema wants — so an unknown pay date or an
/// unpublished FX rate must be nil here, never "".
struct DividendCreateRequest: Encodable, Sendable, Equatable {
    let instrumentId: String
    let portfolioId: String
    let exDate: String
    let payDate: String?
    let quantity: String
    let amountPerShare: String
    let grossAmount: String
    let withheldTax: String
    let currency: Currency
    let fxRateToBase: String?
    let note: String?
}

/// `dividendUpdateSchema` — every stored figure except the instrument and the
/// currency, which the server refuses to rebind.
struct DividendUpdateRequest: Encodable, Sendable, Equatable {
    let portfolioId: String
    let exDate: String
    let payDate: String?
    let quantity: String
    let amountPerShare: String
    let grossAmount: String
    let withheldTax: String
    let fxRateToBase: String?
    let note: String?
}
