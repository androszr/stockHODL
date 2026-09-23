import Foundation

/// Production wiring for the news screens.
extension NewsStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> NewsStore {
        NewsStore(
            client: NewsClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            isConnected: { Reachability.shared.isConnected }
        )
    }
}
