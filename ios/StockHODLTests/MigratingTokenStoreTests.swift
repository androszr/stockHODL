import Foundation
import Testing

@testable import StockHODL

/// The Keychain, minus the Keychain — the same double `AuthFlowTests` uses, for
/// the same reason: the real store needs an entitled, signed process, while the
/// decision of WHICH scope to read and when to drain the old one is ordinary
/// logic that belongs under test.
private final class FakeStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    private(set) var writes = 0
    private(set) var clears = 0
    /// Set to make every operation throw, standing in for a keychain that
    /// refuses — a wrong access group answers `-34018` exactly like this.
    var failure: Error?

    init(initial: String? = nil) { value = initial }

    struct Refused: Error {}

    func read() throws -> String? {
        if let failure { throw failure }
        return lock.withLock { value }
    }

    func write(_ token: String) throws {
        if let failure { throw failure }
        lock.withLock {
            value = token
            writes += 1
        }
    }

    func clear() throws {
        if let failure { throw failure }
        lock.withLock {
            value = nil
            clears += 1
        }
    }

    var stored: String? { lock.withLock { value } }
}

/// What must hold across the update that added the widgets.
///
/// The regression these guard against is not subtle and not rare: it is every
/// phone with the app already installed. A token written before the keychain
/// access group existed does not match a query that carries one, so without
/// this store the update reads "no session" and drops the user at sign-in.
@Suite("MigratingTokenStore")
struct MigratingTokenStoreTests {
    @Test("reads the shared scope without touching the old one")
    func prefersShared() throws {
        let shared = FakeStore(initial: "new")
        let legacy = FakeStore(initial: "old")
        let store = MigratingTokenStore(shared: shared, legacy: legacy)

        #expect(try store.read() == "new")
        // The steady state after migration: no writes, no clears, one lookup.
        #expect(legacy.clears == 0)
        #expect(shared.writes == 0)
    }

    @Test("carries a pre-widget token across without draining the old scope")
    func migrates() throws {
        let shared = FakeStore()
        let legacy = FakeStore(initial: "old")
        let store = MigratingTokenStore(shared: shared, legacy: legacy)

        #expect(try store.read() == "old")
        #expect(shared.stored == "old")
        // NOT drained here — see the note on `MigratingTokenStore.read()`.
        // `SecItemDelete` with no `kSecAttrAccessGroup` matches every group
        // the process can reach, `shared` included; a drain immediately after
        // this copy deleted the copy on-device, every time.
        #expect(legacy.stored == "old")
    }

    @Test("migrates once — the second read is a plain shared hit")
    func migratesOnce() throws {
        let shared = FakeStore()
        let legacy = FakeStore(initial: "old")
        let store = MigratingTokenStore(shared: shared, legacy: legacy)

        _ = try store.read()
        _ = try store.read()

        #expect(shared.writes == 1)
        #expect(legacy.clears == 0)
    }

    @Test("no token anywhere is nil, not a migration")
    func emptyStaysEmpty() throws {
        let shared = FakeStore()
        let legacy = FakeStore()
        let store = MigratingTokenStore(shared: shared, legacy: legacy)

        #expect(try store.read() == nil)
        #expect(shared.writes == 0)
        #expect(legacy.clears == 0)
    }

    @Test("a refused shared scope falls through instead of signing out")
    func sharedFailureDoesNotSignOut() throws {
        let shared = FakeStore()
        // Every operation refuses — what a mis-provisioned access group looks
        // like from here (`-34018`). The token below is still valid, and the
        // caller must get it rather than a thrown configuration mistake.
        shared.failure = FakeStore.Refused()
        let legacy = FakeStore(initial: "old")
        let store = MigratingTokenStore(shared: shared, legacy: legacy)

        #expect(try store.read() == "old")
        // The copy could not land either, so the old scope keeps the token and
        // the migration is simply retried next launch.
        #expect(legacy.stored == "old")
    }

    @Test("signing out empties both scopes")
    func clearDrainsBoth() throws {
        let shared = FakeStore(initial: "new")
        let legacy = FakeStore(initial: "old")
        let store = MigratingTokenStore(shared: shared, legacy: legacy)

        try store.clear()

        #expect(shared.stored == nil)
        // Otherwise the next launch "migrates" the revoked credential back in
        // and the sign-out undoes itself.
        #expect(legacy.stored == nil)
    }

    @Test("a fresh token lands in the shared scope and wins on read, without touching legacy")
    func writeDoesNotTouchLegacy() throws {
        let shared = FakeStore()
        let legacy = FakeStore(initial: "old")
        let store = MigratingTokenStore(shared: shared, legacy: legacy)

        try store.write("new")

        #expect(shared.stored == "new")
        // Left alone, deliberately — draining it here is exactly the bug:
        // `legacy.clear()` reaches every access group the process can see,
        // `shared` included, so a drain right after this write deleted the
        // write on-device, every time. `shared` is checked first on read, so
        // a stale `legacy` value never surfaces while `shared` holds a token.
        #expect(legacy.stored == "old")
        #expect(try store.read() == "new")
    }
}
