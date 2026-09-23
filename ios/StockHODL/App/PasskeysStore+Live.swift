import Foundation

/// Production wiring for the profile's passkey list — same split as every
/// other `+Live` file.
extension PasskeysStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> PasskeysStore {
        PasskeysStore(
            client: PasskeysClient(api: APIClient(config: config)),
            registrar: PasskeyRegistrationController(),
            relyingPartyID: config.relyingPartyID,
            tokenProvider: { auth.sessionToken }
        )
    }
}
