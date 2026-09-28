import Foundation
import Security
import Testing

@testable import StockHODL

/// The keychain query's shape, read without touching the keychain — the real
/// store needs an entitled, signed process; the dictionary it matches on does
/// not (plans/2026-09-28-native-mac-app-stage-1.md).
struct TokenStoreQueryTests {
    private let service = "com.robertandrosz.stockhodl"
    private let account = "session"
    private let group = "KURWX5TYSZ.com.robertandrosz.stockhodl.shared"

    @Test func asksForTheDataProtectionKeychain() {
        for accessGroup in [group, nil] as [String?] {
            let query = KeychainTokenStore.query(service: service, account: account, accessGroup: accessGroup)
            #expect(query[kSecUseDataProtectionKeychain as String] as? Bool == true)
        }
    }

    @Test func carriesTheItemIdentity() {
        let query = KeychainTokenStore.query(service: service, account: account, accessGroup: group)
        #expect(query[kSecClass as String] as? String == kSecClassGenericPassword as String)
        #expect(query[kSecAttrService as String] as? String == service)
        #expect(query[kSecAttrAccount as String] as? String == account)
    }

    @Test func namesTheGroupWhenOneIsGiven() {
        let query = KeychainTokenStore.query(service: service, account: account, accessGroup: group)
        #expect(query[kSecAttrAccessGroup as String] as? String == group)
    }

    /// The legacy scope `MigratingTokenStore` drains is the `nil`-group query:
    /// a group key there would stop it reaching the pre-widget item.
    @Test func legacyQueryCarriesNoGroupKey() {
        let query = KeychainTokenStore.query(service: service, account: account, accessGroup: nil)
        #expect(query[kSecAttrAccessGroup as String] == nil)
        #expect(query.count == 4)
    }
}
