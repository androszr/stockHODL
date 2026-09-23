import Foundation

/// The production wiring, kept out of `AuthStore.swift` on purpose.
///
/// `PasskeyController` imports UIKit, and every file that reaches it becomes
/// unbuildable outside an iOS target. Isolating the one line that names it
/// means `AuthStore`, `AuthClient` and the whole ceremony below them stay
/// platform-free — which is what lets them be tested without a simulator
/// runtime (see docs/ios-native.md A.4 on how that verification runs today).
extension AuthStore {
    static func live(config: AppConfig = .current) -> AuthStore {
        AuthStore(
            auth: AuthClient(api: APIClient(config: config)),
            // Migrating, not plain: a build before the widgets wrote the
            // session with no keychain access group, and querying with one
            // would silently miss it and sign the user out on update.
            tokens: MigratingTokenStore(),
            passkeys: PasskeyController(),
            relyingPartyID: config.relyingPartyID,
            // The real one, so a launch that cannot reach the server keeps the
            // screen it had rather than falling to sign-in.
            users: DefaultsSessionUserCache()
        )
    }
}
