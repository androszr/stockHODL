import Foundation

/// Moves an existing session out of the app's private keychain scope and into
/// the shared access group the widgets read, exactly once, without asking the
/// user for a passkey.
///
/// The problem it solves is a real regression, not a hypothetical: every phone
/// that already has this app installed holds a token written with NO
/// `kSecAttrAccessGroup`. The moment the app starts querying WITH a group,
/// that item stops matching — `read()` answers `errSecItemNotFound`, the app
/// concludes there is no session, and the user is dropped at the sign-in screen
/// by an update that was supposed to add a widget.
///
/// So this store reads the shared scope first, falls back to the private one,
/// and — having found the old item — copies it across and deletes the original.
/// Copy before delete: the reverse order has a window in which a crash loses
/// the session outright, and the whole point of this type is that the user
/// never notices the move happened.
///
/// It is deliberately pure composition over two `TokenStore`s rather than a
/// second pile of `SecItem*` calls. The Keychain cannot run in a plain unit
/// test — it needs an entitled, signed process — but "read here, else read
/// there, then copy, then delete" is precisely the part that can be wrong, and
/// with two in-memory doubles it is the part a test pins down.
///
/// Once the migration has run, `legacy` is empty forever and every call is one
/// `shared` lookup plus one miss on an empty store.
struct MigratingTokenStore: TokenStore {
    /// The access-group scope both the app and its widgets can reach.
    let shared: TokenStore
    /// The pre-widget, app-private scope. Read, never written to. Drained on
    /// explicit sign-out (`clear()`) — NOT right after a migration or a fresh
    /// write, because `SecItemDelete` with no `kSecAttrAccessGroup` reaches
    /// every group the process can see, `shared` included, and would delete
    /// what was just written there.
    let legacy: TokenStore

    init(
        shared: TokenStore = KeychainTokenStore(),
        legacy: TokenStore = KeychainTokenStore(accessGroup: nil)
    ) {
        self.shared = shared
        self.legacy = legacy
    }

    func read() throws -> String? {
        // `try?` on the shared scope, deliberately. A keychain query can fail
        // for reasons that have nothing to do with whether a session exists —
        // a mis-provisioned access group answers `-34018`, and that is exactly
        // the failure this change could introduce. Propagating it would sign
        // the user out over a configuration mistake while a perfectly good
        // token sits in the scope below; falling through finds it.
        do {
            if let token = try shared.read() {
                #if DEBUG
                    print("[migrating-token] shared hit")
                #endif
                return token
            }
            #if DEBUG
                print("[migrating-token] shared: no item")
            #endif
        } catch {
            #if DEBUG
                print("[migrating-token] shared threw: \(error)")
            #endif
        }
        let legacyResult: String?
        do {
            legacyResult = try legacy.read()
        } catch {
            #if DEBUG
                print("[migrating-token] legacy threw: \(error)")
            #endif
            throw error
        }
        guard let carried = legacyResult else {
            #if DEBUG
                print("[migrating-token] legacy: no item either")
            #endif
            return nil
        }
        #if DEBUG
            print("[migrating-token] legacy hit, migrating")
        #endif

        // Copy. NOT followed by draining `legacy` here — `SecItemDelete` with
        // no `kSecAttrAccessGroup` in the query does not mean "only items with
        // no group"; observed on-device, it matches EVERY group the process
        // can reach, `shared` included. A drain right after the copy deleted
        // the copy itself, every time — sign-in silently "succeeded" and the
        // token was gone a line later. `legacy` is left in place; the next
        // migration attempt is idempotent, so this only costs a repeat read.
        //
        // Neither failure fails the READ: the caller has a valid token in
        // hand. A migration that did not happen is retried next launch.
        try? shared.write(carried)
        return carried
    }

    func write(_ token: String) throws {
        try shared.write(token)
        // Not followed by `legacy.clear()` — see the note above. Clearing
        // right after this write would delete the write.
    }

    func clear() throws {
        try shared.clear()
        // Sign-out must empty BOTH scopes. Clearing only the shared one would
        // leave the pre-widget item to be "migrated" back in on the next
        // launch — a sign-out that undoes itself.
        try legacy.clear()
    }
}
