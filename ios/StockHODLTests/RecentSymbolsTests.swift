import Foundation
import Testing

@testable import StockHODL

/// A throwaway defaults domain per test — process-wide state, and a test that
/// wrote the standard suite would decide what an unrelated test opens on.
private func scratchDefaults() -> UserDefaults {
    UserDefaults(suiteName: "test.\(UUID().uuidString)")!
}

@Suite("Recent symbols")
@MainActor
struct RecentSymbolsTests {
    @Test("fresh defaults are empty")
    func freshEmpty() {
        let store = RecentSymbolsStore(defaults: scratchDefaults())
        #expect(store.items.isEmpty)
    }

    @Test("record inserts at the front, newest first")
    func insertsAtFront() {
        let store = RecentSymbolsStore(defaults: scratchDefaults())

        store.record(symbol: "AAPL", name: "Apple")
        store.record(symbol: "MSFT", name: "Microsoft")
        store.record(symbol: "NVDA", name: "NVIDIA")

        #expect(store.items.map(\.symbol) == ["NVDA", "MSFT", "AAPL"])
    }

    @Test("re-recording moves to the front, updates the name, and leaves no duplicate")
    func rerecordingMovesAndRenames() {
        let store = RecentSymbolsStore(defaults: scratchDefaults())

        store.record(symbol: "AAPL", name: "Apple")
        store.record(symbol: "MSFT", name: "Microsoft")
        store.record(symbol: "AAPL", name: "Apple Inc.")

        #expect(store.items == [
            RecentSymbol(symbol: "AAPL", name: "Apple Inc."),
            RecentSymbol(symbol: "MSFT", name: "Microsoft"),
        ])
    }

    @Test("a ninth record drops the oldest; count stays 8")
    func capsAtEight() {
        let store = RecentSymbolsStore(defaults: scratchDefaults())
        for index in 1...9 {
            store.record(symbol: "T\(index)", name: "Name \(index)")
        }

        #expect(store.items.count == 8)
        #expect(store.items.first?.symbol == "T9")
        #expect(store.items.last?.symbol == "T2")
        #expect(!store.items.contains { $0.symbol == "T1" })
    }

    @Test("a second store over the same defaults sees the same items in the same order")
    func roundTrip() {
        let defaults = scratchDefaults()
        let first = RecentSymbolsStore(defaults: defaults)
        first.record(symbol: "AAPL", name: "Apple")
        first.record(symbol: "NVDA", name: "NVIDIA")

        let second = RecentSymbolsStore(defaults: defaults)
        #expect(second.items == first.items)
        #expect(second.items.map(\.symbol) == ["NVDA", "AAPL"])
    }

    @Test("purge empties the store and a fresh store over the same defaults is empty too")
    func purgeClearsPersistence() {
        let defaults = scratchDefaults()
        let store = RecentSymbolsStore(defaults: defaults)
        store.record(symbol: "AAPL", name: "Apple")
        store.purge()

        #expect(store.items.isEmpty)
        #expect(RecentSymbolsStore(defaults: defaults).items.isEmpty)
    }

    @Test("garbage bytes under the recents key decode to empty, not a crash")
    func garbageDecodesEmpty() {
        let defaults = scratchDefaults()
        defaults.set(Data("not-json".utf8), forKey: "search.recents")

        let store = RecentSymbolsStore(defaults: defaults)
        #expect(store.items.isEmpty)
    }
}
