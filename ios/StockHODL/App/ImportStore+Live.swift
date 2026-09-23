import Foundation

/// Production wiring for the screenshot importers.
extension ImportStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> ImportStore {
        ImportStore(
            client: ImportClient(api: APIClient(config: config)),
            tokenProvider: { auth.sessionToken }
        )
    }
}
