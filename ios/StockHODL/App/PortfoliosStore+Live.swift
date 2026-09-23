import Foundation

/// Production wiring for portfolio management.
extension PortfoliosStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> PortfoliosStore {
        PortfoliosStore(
            client: PortfoliosClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}

/// Production wiring for the Holdings chart.
extension PortfolioChartStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> PortfolioChartStore {
        PortfolioChartStore(
            client: PortfolioSeriesClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken }
        )
    }
}
