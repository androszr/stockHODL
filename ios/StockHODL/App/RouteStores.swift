import Foundation

/// The stores for screens that are minted PER PUSH, memoised by route key.
///
/// `navigationDestination`'s closure is not called once per push — SwiftUI
/// re-invokes it every time the view that owns the stack re-evaluates its
/// body, and it does that for a tab switch, a sheet flag, a scene change or
/// any other bit of shell state. A store constructed inside that closure was
/// therefore replaced by a brand-new, empty one on the very next re-render,
/// while the `.task` that filled the previous instance had already run and
/// would never run again. The pushed screen sat on its spinner forever. That
/// is the whole reason this type exists.
///
/// A reference type rather than more `@State`: the lookup happens DURING body
/// evaluation, and writing to `@State` there is the other way to break a
/// SwiftUI view. Nothing here is `@Observable` either — the cache is an
/// identity map, not a source of truth, and nothing should re-render because
/// an entry was added to it.
///
/// Bounded on purpose. A session that walks through forty tickers must not
/// hold forty live stores, so the map keeps the most recently opened
/// `limit` symbols and drops the rest. An evicted symbol simply reloads the
/// next time it is opened — the same thing that happened before this cache
/// existed, only now it happens once instead of on every re-render.
@MainActor
final class RouteStores {
    /// Deep enough that walking a book and stepping back through it never
    /// refetches, small enough that it cannot grow into a leak.
    private let limit: Int

    private var instruments: [String: InstrumentStore] = [:]
    /// Most recent last.
    private var instrumentOrder: [String] = []

    /// The market detail stores, by tile key. Four keys at most, so the
    /// bound is the enum's own; kept in a map for the same identity reason.
    private var marketDetails: [MarketTileKey: MarketDetailStore] = [:]

    init(limit: Int = 12) {
        self.limit = limit
    }

    /// The store for one ticker, built at most once per symbol.
    func instrument(_ symbol: String, make: () -> InstrumentStore) -> InstrumentStore {
        touch(symbol)
        if let existing = instruments[symbol] { return existing }
        let fresh = make()
        instruments[symbol] = fresh
        evictOverflow()
        return fresh
    }

    /// The store for one market tile, built at most once per key.
    func marketDetail(_ key: MarketTileKey, make: () -> MarketDetailStore) -> MarketDetailStore {
        if let existing = marketDetails[key] { return existing }
        let fresh = make()
        marketDetails[key] = fresh
        return fresh
    }

    /// Everything derived from the account, dropped on sign-out — the same
    /// contract every other store's `purge()` honours.
    func purge() {
        instruments.removeAll()
        instrumentOrder.removeAll()
        marketDetails.removeAll()
    }

    /// Test seam: how many instrument stores are currently held.
    var instrumentCount: Int { instruments.count }

    /// Test seam: how many market detail stores are currently held.
    var marketDetailCount: Int { marketDetails.count }

    private func touch(_ symbol: String) {
        instrumentOrder.removeAll { $0 == symbol }
        instrumentOrder.append(symbol)
    }

    private func evictOverflow() {
        while instrumentOrder.count > limit {
            let oldest = instrumentOrder.removeFirst()
            instruments[oldest] = nil
        }
    }
}
