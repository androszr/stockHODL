import Foundation

/// Production wiring for the instrument screen — same split as
/// `LiveStore+Live.swift`: the store names nothing device-specific so a test
/// can drive it, and the real base URL and the real Keychain meet it here.
extension InstrumentStore {
    @MainActor
    static func live(
        symbol: String,
        auth: AuthStore,
        seed: InstrumentSeed? = nil,
        config: AppConfig = .current
    ) -> InstrumentStore {
        let api = APIClient(config: config)
        return InstrumentStore(
            symbol: symbol,
            client: InstrumentClient(api: api),
            // Whatever the screen the user tapped from already knew. Costs
            // nothing when the network answers — `detail` replaces it on the
            // first paint — and is the difference between a stock page and an
            // error screen when it does not.
            seed: seed,
            // The watch control on this screen writes to the same endpoints
            // the Watchlist tab does — one membership, one implementation.
            watchlist: WatchlistClient(api: api),
            // Deleting a row here writes to the same journal endpoint the
            // Transactions tab does.
            transactionsClient: TransactionsClient(api: api),
            // Read through, never captured: the token is rotated by sign-out
            // and reissued by the next sign-in.
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}
