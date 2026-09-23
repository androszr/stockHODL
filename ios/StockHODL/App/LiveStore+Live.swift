import Foundation

/// Production wiring for the Holdings data layer.
///
/// Separate from `LiveStore.swift` for the same reason `AuthStore+Live.swift`
/// exists: the store itself must name nothing that ties it to a device, so it
/// can be driven by fakes in a test. This file is where the real Keychain, the
/// real App Group container and the real base URL meet it.
extension LiveStore {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> LiveStore {
        LiveStore(
            client: LiveClient(api: APIClient(config: config)),
            // Wrapped, not bare: writing a snapshot is the moment the
            // widgets' figures went out of date, and the decorator is what
            // keeps WidgetKit out of `LiveStore` itself.
            snapshots: WidgetNudgingSnapshotStore(),
            // Read through the auth store rather than captured once: the token
            // is rotated by sign-out and re-issued by the next sign-in, and a
            // captured copy would keep the dead one.
            tokenProvider: { auth.sessionToken },
            // The OS's view of the radio, read fresh on every call rather
            // than captured: the whole value of `Reachability` is that its
            // answer changes.
            isConnected: { Reachability.shared.isConnected }
        )
    }
}
