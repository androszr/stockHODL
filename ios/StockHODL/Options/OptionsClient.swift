import Foundation

/// The options tab's reads, writes and contract-chain lookups.
///
/// Poll only — there is no stream method here and that is deliberate, not an
/// omission: the server has no options SSE twin, the vendor's options socket
/// entitlement is unverified, and 60 s is honest for figures already delayed
/// 15 minutes. See `/api/mobile/v1/options`.
struct OptionsClient: Sendable {
    let api: APIClient

    func payload(token: String) async throws -> OptionsPayload {
        try await api.decode(
            OptionsPayload.self,
            from: APIRequest(path: "/api/mobile/v1/options", bearerToken: token)
        )
    }

    /// The whole tracked book's value line, or one contract's when `ticker` is
    /// given. It is the OCC TICKER, never the card key — a card can be a
    /// `ticker#rowId` group, which matches no row.
    func series(
        range: OptionsChartRange,
        ticker: String? = nil,
        token: String
    ) async throws -> SeriesPayload {
        var query = ["range": range.rawValue]
        if let ticker { query["ticker"] = ticker }
        return try await api.decode(
            SeriesPayload.self,
            from: APIRequest(
                path: "/api/mobile/v1/series/options",
                query: query,
                bearerToken: token
            )
        )
    }

    func expirations(underlying: String, token: String) async throws -> OptionExpirationsResponse {
        try await api.decode(
            OptionExpirationsResponse.self,
            from: APIRequest(
                path: "/api/mobile/v1/options/expirations",
                query: ["underlying": underlying],
                bearerToken: token
            )
        )
    }

    func strikes(
        underlying: String,
        expirationDate: String,
        contractType: String,
        token: String
    ) async throws -> OptionStrikesResponse {
        try await api.decode(
            OptionStrikesResponse.self,
            from: APIRequest(
                path: "/api/mobile/v1/options/strikes",
                query: [
                    "underlying": underlying,
                    "expirationDate": expirationDate,
                    "contractType": contractType,
                ],
                bearerToken: token
            )
        )
    }

    /// THE VERIFICATION GATE for a screenshot import — the same server call
    /// the web wizard makes (`matchOptionContract`), and the near-miss
    /// fallback the cascade's own exact-string match cannot offer: an expiry
    /// or strike read a shade off what the vendor lists comes back `nearby`
    /// with the closest real contracts, instead of a bare "not found".
    func match(_ body: OptionMatchRequest, token: String) async throws -> OptionMatchResponse {
        try await api.decode(
            OptionMatchResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/import/option/match",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    func add(_ body: OptionAddRequest, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/options",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    func update(_ body: OptionEditRequest, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "PATCH",
                path: "/api/mobile/v1/options/\(body.id)",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    func remove(lotID: String, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "DELETE",
                path: "/api/mobile/v1/options/\(lotID)",
                bearerToken: token
            )
        )
    }
}

/// The add body — `optionPositionAddSchema` in `src/lib/validation.ts`.
///
/// Hand-written rather than generated, like every other request shape: the
/// input schema carries transforms (trims, the pl-PL comma normalisation), and
/// a JSON Schema describes a shape rather than a transform, so generating from
/// it would emit a struct for the POST-transform value the client never sends.
///
/// Contract identity comes from a vendor `OptionContractRef` and is never
/// typed by hand — a strike or an expiry the user typed would name a contract
/// that does not exist, and the vendor would price nothing forever.
struct OptionAddRequest: Encodable, Sendable, Equatable {
    let ticker: String
    let underlying: String
    let contractType: String
    let strikePrice: String
    let expirationDate: String
    let sharesPerContract: String
    let quantity: String
    let entryPrice: String
    let tradeDate: String
    let fees: String

    init(
        contract: OptionContractRef,
        quantity: String,
        entryPrice: String,
        tradeDate: String,
        fees: String
    ) {
        self.ticker = contract.ticker
        self.underlying = contract.underlying
        self.contractType = contract.contractType.rawValue
        self.strikePrice = contract.strikePrice
        self.expirationDate = contract.expirationDate
        self.sharesPerContract = contract.sharesPerContract
        self.quantity = quantity
        self.entryPrice = entryPrice
        self.tradeDate = tradeDate
        self.fees = fees
    }
}

/// The edit body — `optionPositionEditSchema`, which is STRICT. Contract
/// identity is absent by design and not by omission: changing the contract is
/// really a different position, handled by remove + re-add. Sending a
/// `ticker` here would be a 400, which is the intended answer.
struct OptionEditRequest: Encodable, Sendable, Equatable {
    let id: String
    let quantity: String
    let entryPrice: String
    let tradeDate: String
    let fees: String
}
