import Foundation

/// The market strip's one read.
///
/// One method and no query parameters, which mirrors the server exactly: the
/// symbol set is a constant inside `loadMarketStrip`, so there is nothing for
/// a caller to steer and no way for this route to become an open quote proxy.
///
/// Poll only, like `OptionsClient`: there is no market-strip stream on the
/// server and that is deliberate, not an omission — the figures are 15-minute
/// delayed and the spark grows one bar every five minutes.
struct MarketStripClient: Sendable {
    let api: APIClient

    func payload(token: String) async throws -> MarketStripPayload {
        try await api.decode(
            MarketStripPayload.self,
            from: APIRequest(path: "/api/mobile/v1/market-strip", bearerToken: token)
        )
    }

    /// The chart behind one tile. The path segment is the closed enum's raw
    /// value — the server refuses anything else with the empty payload, so
    /// this cannot chart an arbitrary ticker even if a key were forged.
    func series(key: MarketTileKey, range: ChartRange, token: String) async throws -> SeriesPayload {
        try await api.decode(
            SeriesPayload.self,
            from: APIRequest(
                path: "/api/mobile/v1/market-strip/series/\(key.rawValue)",
                query: ["range": range.rawValue],
                bearerToken: token
            )
        )
    }
}
