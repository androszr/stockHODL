import Foundation

/// Production wiring for the dividends screen.
extension DividendsStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> DividendsStore {
        DividendsStore(
            client: DividendsClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}

extension DividendFormStore {
    /// One factory for both modes: a payment means correct, nil means add.
    @MainActor
    static func live(
        editing payment: DividendPayment?,
        auth: AuthStore,
        config: AppConfig = .current
    ) -> DividendFormStore {
        let client = DividendsClient(api: APIClient(config: config))
        let token: @MainActor () -> String? = { auth.sessionToken }
        let connected: @MainActor () -> Bool = { Reachability.shared.isConnected }

        guard let payment else {
            return DividendFormStore(
                client: client,
                tokenProvider: token,
                isConnected: connected
            )
        }
        return DividendFormStore.editing(
            payment,
            client: client,
            tokenProvider: token,
            isConnected: connected
        )
    }
}
