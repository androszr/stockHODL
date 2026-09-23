import Foundation

/// Production wiring for the market detail screen — the `InstrumentStore+Live`
/// split: the store names nothing device-specific so a test can drive it,
/// and the real base URL and the real Keychain meet it here.
extension MarketDetailStore {
    @MainActor
    static func live(
        key: MarketTileKey,
        auth: AuthStore,
        config: AppConfig = .current
    ) -> MarketDetailStore {
        MarketDetailStore(
            key: key,
            // The same client the strip polls with: one door on the server,
            // one type on the phone.
            client: MarketStripClient(api: APIClient(config: config)),
            // Read through, never captured: the token is rotated by sign-out
            // and reissued by the next sign-in.
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}
