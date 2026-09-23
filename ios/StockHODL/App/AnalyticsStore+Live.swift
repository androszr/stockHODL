import Foundation

/// Production wiring for the analytics screen.
extension AnalyticsStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> AnalyticsStore {
        AnalyticsStore(
            client: AnalyticsClient(api: APIClient(config: config)),
            targetsClient: TargetsClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}
