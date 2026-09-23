import Foundation
import Security

/// Where the session token lives.
///
/// A protocol rather than a bare Keychain call because the Keychain is the one
/// part of this stage that cannot run in a plain unit test — it needs an
/// entitled, signed process — while the logic that decides WHEN to store and
/// when to purge is exactly what a test should pin down. `AuthStore` talks to
/// this; the tests hand it an in-memory double.
protocol TokenStore: Sendable {
    func read() throws -> String?
    func write(_ token: String) throws
    func clear() throws
}

/// The real one.
///
/// `kSecAttrAccessibleAfterFirstUnlock` is the deliberate choice: the token must
/// survive a reboot without the user unlocking first only insofar as a
/// background refresh might want it later (C2), and `WhenUnlocked` would break
/// that; `Always` is deprecated and would put a seven-day credential on a
/// device that has never been unlocked. `ThisDeviceOnly` is NOT set, so the
/// item can ride an encrypted device-to-device migration — losing it would
/// merely cost one Face ID, but keeping it is free and the token is
/// revocable server-side either way.
///
/// `kSecAttrAccessGroup` arrived with the widgets. A widget extension is a
/// separate process with its own keychain scope, so a token written without an
/// access group is one the widget cannot see at all — it would render "sign in"
/// forever beside a perfectly signed-in app. The group comes from the bundle
/// (`KeychainAccessGroup`, expanded from `$(AppIdentifierPrefix)…` by the
/// xcconfig) for the same reason `APIBaseURL` does: the team prefix is a build
/// fact, and a Swift literal for it is a runtime `-34018` waiting for the first
/// person who re-signs the app.
///
/// Passing `accessGroup: nil` addresses the pre-widget item — the one written
/// by a build that had no group at all. That is not a legacy curiosity: it is
/// what is on the phone right now, and `MigratingTokenStore` is what moves it.
struct KeychainTokenStore: TokenStore {
    /// NOT `Bundle.main.bundleIdentifier`. That was the previous default, and
    /// it is a DIFFERENT string in every process this type runs in: the app is
    /// `com.robertandrosz.stockhodl`, the widget extension is
    /// `com.robertandrosz.stockhodl.widgets`. Same account, same access group,
    /// but `kSecAttrService` is part of an item's identity too, so the two
    /// processes were quietly filing the token under two different keychain
    /// items. Reproduced on-device: the app read the token it had just written
    /// (`status=0`) while the widget extension, querying at that same moment,
    /// got `errSecItemNotFound` for it — the access group was never the
    /// problem, the service string was. `sharedService` reads one literal value
    /// out of each target's own Info.plist instead, the same pattern
    /// `sharedAccessGroup` already uses below.
    private let service: String
    private let account = "session-token"
    /// Nil means "no `kSecAttrAccessGroup` attribute at all", which is a
    /// DIFFERENT query from any group — it is the app's private scope, and the
    /// only thing that can still reach the pre-widget item.
    private let accessGroup: String?

    /// One value, expanded into both targets' Info.plist from the same
    /// xcconfig key — so the app and the widget extension can never file the
    /// token under two different services again.
    static func sharedService(from bundle: Bundle = .main) -> String {
        bundle.object(forInfoDictionaryKey: "KeychainService") as? String ?? "com.robertandrosz.stockhodl"
    }

    /// The shared group this build writes to, or nil when the key is absent —
    /// which is the case in a unit-test host and must not be fatal, unlike
    /// `AppConfig`'s missing base URL. A token in the app's private scope still
    /// signs the app in; only the widget goes dark.
    static func sharedAccessGroup(from bundle: Bundle = .main) -> String? {
        bundle.object(forInfoDictionaryKey: "KeychainAccessGroup") as? String
    }

    init(
        service: String = KeychainTokenStore.sharedService(),
        accessGroup: String? = KeychainTokenStore.sharedAccessGroup()
    ) {
        self.service = service
        self.accessGroup = accessGroup
    }

    enum KeychainError: Error, CustomStringConvertible {
        case unexpectedStatus(OSStatus)

        var description: String {
            switch self {
            case let .unexpectedStatus(status):
                "Keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")"
            }
        }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    func read() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        #if DEBUG
            print("[keychain] read(group: \(accessGroup ?? "nil")) status=\(status)")
        #endif

        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ token: String) throws {
        let data = Data(token.utf8)

        // Delete first, then add — never `SecItemUpdate`. On this app's
        // access-group scope, `SecItemUpdate` was observed on-device to
        // report `errSecSuccess` while leaving the item unreadable by the
        // very next `SecItemCopyMatching` on an identical query — reproduced
        // repeatedly, isolated from every other explanation (provisioning
        // profile, entitlements, payload size all checked out; a fresh
        // `SecItemAdd` on the same key was immediately readable every time).
        // The old comment here warned that delete-then-add leaves a window
        // with no token at all; that is a real but narrow theoretical race
        // for another reader, and a small price for a write path that
        // actually works.
        SecItemDelete(baseQuery as CFDictionary)

        var insert = baseQuery
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        #if DEBUG
            print("[keychain] write add(group: \(accessGroup ?? "nil")) status=\(addStatus)")
        #endif
        guard addStatus == errSecSuccess else { throw KeychainError.unexpectedStatus(addStatus) }
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        // Nothing to delete is the desired end state, not a failure.
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
