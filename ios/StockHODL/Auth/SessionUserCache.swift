import Foundation

/// The last user the server confirmed, remembered so a launch without a
/// working connection is not a sign-out.
///
/// `AuthStore.restore()` cannot prove a stored token is still good without
/// asking, and asking needs a network. Before this existed, a launch in a
/// tunnel — or the first launch after iOS reclaimed the app, which off the
/// debugger is most launches — fell all the way back to the sign-in screen
/// while a perfectly valid token sat in the Keychain and a full snapshot sat
/// in the App Group container. The token was kept; the SCREEN was not, which
/// from the user's side is the same thing as being logged out.
///
/// Only identity is stored, and only what the app already renders: an id, an
/// email and a name. The token stays in the Keychain, which is the thing worth
/// protecting — this is the label on it, not the key.
protocol SessionUserCaching: Sendable {
    func read() -> SessionUser?
    func write(_ user: SessionUser)
    func clear()
}

/// `UserDefaults`, because this is a UI-continuity fact rather than a secret,
/// and the Keychain is not free to read on a cold launch.
///
/// `@unchecked` because `UserDefaults` is documented as thread-safe and simply
/// predates `Sendable`; nothing else is stored here.
struct DefaultsSessionUserCache: SessionUserCaching, @unchecked Sendable {
    private static let key = "auth.lastSessionUser"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func read() -> SessionUser? {
        guard let data = defaults.data(forKey: Self.key) else { return nil }
        return try? JSONDecoder().decode(SessionUser.self, from: data)
    }

    func write(_ user: SessionUser) {
        guard let data = try? JSONEncoder().encode(user) else { return }
        defaults.set(data, forKey: Self.key)
    }

    func clear() {
        defaults.removeObject(forKey: Self.key)
    }
}

/// The default an `AuthStore` gets when nobody says otherwise — so a test
/// never touches the process-wide defaults, which is the same rule
/// `LiveStore` follows for the selected scope.
final class InMemorySessionUserCache: SessionUserCaching, @unchecked Sendable {
    private let lock = NSLock()
    private var user: SessionUser?

    init(user: SessionUser? = nil) {
        self.user = user
    }

    func read() -> SessionUser? { lock.withLock { user } }
    func write(_ user: SessionUser) { lock.withLock { self.user = user } }
    func clear() { lock.withLock { user = nil } }
}
