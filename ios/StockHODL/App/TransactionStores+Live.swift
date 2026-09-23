import Foundation

/// Production wiring for the transaction screens — same split as
/// `LiveStore+Live.swift`.
extension TransactionsStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> TransactionsStore {
        TransactionsStore(
            client: TransactionsClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}

extension TransactionFormStore {
    /// One factory for both modes: a row means edit, nil means add.
    @MainActor
    static func live(
        editing row: TransactionRow?,
        auth: AuthStore,
        config: AppConfig = .current
    ) -> TransactionFormStore {
        let client = TransactionsClient(api: APIClient(config: config))
        let token: @MainActor () -> String? = { auth.sessionToken }
        let connected: @MainActor () -> Bool = { Reachability.shared.isConnected }

        guard let row else {
            return TransactionFormStore(
                client: client,
                tokenProvider: token,
                isConnected: connected
            )
        }
        return TransactionFormStore.editing(
            row,
            client: client,
            tokenProvider: token,
            isConnected: connected
        )
    }
}

extension WatchlistStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> WatchlistStore {
        WatchlistStore(
            client: WatchlistClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}

extension OptionsStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> OptionsStore {
        OptionsStore(
            client: OptionsClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}

extension MarketStripStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> MarketStripStore {
        MarketStripStore(
            client: MarketStripClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}

extension OptionFormStore {
    /// One factory for both modes: `.add` runs the contract cascade, `.edit`
    /// prefills a lot's raw fields.
    @MainActor
    static func live(
        mode: Mode,
        auth: AuthStore,
        config: AppConfig = .current
    ) -> OptionFormStore {
        OptionFormStore(
            mode: mode,
            client: OptionsClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken }
        )
    }
}
