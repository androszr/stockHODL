import Foundation

/// The instrument screen's two reads.
///
/// Both are addressed by SYMBOL, which is what the caller already holds after
/// tapping a card — no id lookup round trip. The server resolves the symbol
/// within the caller's own transactions and watchlist, so a ticker that is not
/// the user's is indistinguishable from one that never existed.
struct InstrumentClient: Sendable {
    let api: APIClient

    /// Everything above the chart: price, day change, the position, the
    /// per-portfolio breakdown and the transactions.
    ///
    /// A 404 here means "no such instrument, for you" and is a legitimate
    /// answer rather than a failure — see `InstrumentStore`.
    func detail(symbol: String, token: String) async throws -> InstrumentResponse {
        try await api.decode(
            InstrumentResponse.self,
            from: APIRequest(path: "/api/mobile/v1/instrument/\(symbol)", bearerToken: token)
        )
    }

    /// The price series for one range.
    ///
    /// Note the asymmetry with `detail`, which is the server's and worth not
    /// "fixing" here: the series answers a refusal with an EMPTY PAYLOAD, never
    /// a 404, because a chart that 404s differently for "exists but not yours"
    /// would enumerate the global instruments table one request at a time.
    func priceSeries(symbol: String, range: ChartRange, token: String) async throws -> SeriesPayload {
        try await api.decode(
            SeriesPayload.self,
            from: APIRequest(
                path: "/api/mobile/v1/series/price/\(symbol)",
                query: ["range": range.rawValue],
                bearerToken: token
            )
        )
    }

    /// Draw a price line. Both mutations answer the instrument's FRESH target
    /// list, so the screen updates without refetching the whole detail
    /// payload — the server's `priceTargetsResponseSchema` contract.
    func createTarget(_ body: PriceTargetCreateRequest, token: String) async throws -> PriceTargetsResponse {
        try await api.decode(
            PriceTargetsResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/price-targets",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    /// Remove a line. Idempotent on the server (the watchlist-delete rule):
    /// an already-gone target still answers ok, with an empty list because no
    /// instrument is then knowable — the store reconciles that case locally.
    func deleteTarget(id: String, token: String) async throws -> PriceTargetsResponse {
        try await api.decode(
            PriceTargetsResponse.self,
            from: APIRequest(
                method: "DELETE",
                path: "/api/mobile/v1/price-targets/\(id)",
                bearerToken: token
            )
        )
    }
}

/// The create body — `priceTargetCreateRequestSchema` in
/// `src/lib/api/contracts/price-targets.ts`. Hand-written rather than
/// generated, like every other request shape: the price bound carries the
/// pl-PL comma normalisation transform, and a JSON Schema describes a shape,
/// not a transform. The caller normalises through
/// `normalizeDecimalSeparator` before encoding, exactly as the transaction
/// form does.
struct PriceTargetCreateRequest: Encodable, Sendable, Equatable {
    let instrumentId: String
    /// A decimal string, already normalised — never a `Double`.
    let targetPrice: String
}
