import Foundation

/// Production wiring for the price-alert push toggle — same split as every
/// other `+Live` file.
extension NotificationsStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> NotificationsStore {
        NotificationsStore(
            client: PushTokenClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken },
            environment: config.pushEnvironment
        )
    }
}
