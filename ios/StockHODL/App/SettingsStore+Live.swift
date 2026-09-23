import Foundation

/// Production wiring for the settings screen.
extension SettingsStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> SettingsStore {
        SettingsStore(
            client: SettingsClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken }
        )
    }
}
