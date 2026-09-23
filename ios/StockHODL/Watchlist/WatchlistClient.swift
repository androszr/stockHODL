import Foundation

/// The watchlist's reads, writes and stream.
///
/// Membership and quotes are separate calls on purpose, mirroring the server:
/// a watch is pure membership, and the figures change every few seconds while
/// the list itself changes a few times a year.
struct WatchlistClient: Sendable {
    let api: APIClient

    func items(token: String) async throws -> [WatchedItem] {
        try await api.decode(
            WatchlistResponse.self,
            from: APIRequest(path: "/api/mobile/v1/watchlist", bearerToken: token)
        ).items
    }

    func quotes(token: String) async throws -> WatchlistPayload {
        try await api.decode(
            WatchlistPayload.self,
            from: APIRequest(path: "/api/mobile/v1/watchlist/quotes", bearerToken: token)
        )
    }

    /// The same lifecycle as the holdings stream, over the shared parser: a
    /// clean end means reconnect, `fallback` means poll, `idle` means go quiet.
    func stream(token: String) -> AsyncThrowingStream<StreamEvent<WatchlistPayload>, Error> {
        api.events(path: "/api/mobile/v1/watchlist/quotes/stream", token: token)
    }

    /// Adding mints or resolves an instrument exactly as a transaction does,
    /// through the same rules — which is why the caller submits a whole
    /// `SymbolMatch` rather than a bare ticker. A typo'd currency would bind
    /// the symbol permanently, `instruments` being global and first-write-wins.
    func add(_ body: WatchlistAddRequest, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "POST",
                path: "/api/mobile/v1/watchlist",
                body: try JSONEncoder().encode(body),
                bearerToken: token
            )
        )
    }

    func remove(instrumentId: String, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "DELETE",
                path: "/api/mobile/v1/watchlist/\(instrumentId)",
                bearerToken: token
            )
        )
    }
}

/// The add body — `watchlistAddSchema` in `src/lib/validation.ts`.
///
/// Hand-written rather than generated, like every other request shape: the
/// input schema carries transforms (`.trim()`, `.toUpperCase()`), and a JSON
/// Schema describes a shape rather than a transform, so generating from it
/// would emit a struct for the POST-transform value the client never sends.
struct WatchlistAddRequest: Encodable, Sendable, Equatable {
    let symbol: String
    let displayName: String
    let exchange: String
    let currency: Currency

    /// The instrument, stated outright. Declaring `init?` below suppresses
    /// the synthesised memberwise initialiser, and the instrument screen has
    /// the four fields already — from the SERVER's own row for the symbol,
    /// which is the one source that cannot be guessing at a currency.
    init(symbol: String, displayName: String, exchange: String, currency: Currency) {
        self.symbol = symbol
        self.displayName = displayName
        self.exchange = exchange
        self.currency = currency
    }

    /// From a search result, with the same bounds the form applies. Returns
    /// nil when the match cannot make a valid instrument — an unmapped
    /// currency being the realistic case, and guessing USD for it being the
    /// mistake that cannot be undone.
    init?(_ match: SymbolMatch) {
        guard let currency = match.currency else { return nil }

        let symbol = match.symbol.trimmed().uppercased()
        let name = match.name.trimmed()
        let exchange = match.exchangeDisplay.trimmed()
        guard !symbol.isEmpty, symbol.count <= 20,
              !name.isEmpty, name.count <= 80,
              !exchange.isEmpty, exchange.count <= 20
        else { return nil }

        self.symbol = symbol
        self.displayName = name
        self.exchange = exchange
        self.currency = currency
    }
}
