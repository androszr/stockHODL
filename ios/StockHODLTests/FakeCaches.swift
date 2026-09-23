import Foundation

@testable import StockHODL

/// A payload cache held in memory.
///
/// Every store that caches takes its cache by protocol, and every test must
/// pass one of these — a store built with the default `DiskCache` writes into
/// the REAL Caches directory of whichever simulator is running, which makes a
/// test suite that passes on a clean machine and fails on the second run
/// because the previous run left a payload behind. Swift Testing also runs
/// suites in parallel, so two tests sharing one directory is not a theoretical
/// race. Same rule, same reasoning as the throwaway `UserDefaults` domain in
/// `LiveStoreTests`.
///
/// `@unchecked Sendable` with a lock rather than an actor, because
/// `PayloadCaching` is deliberately synchronous: the real one is a single file
/// read the UI wants before its first paint, and an async fake would change
/// the timing the tests exist to pin.
final class FakePayloadCache<Value: Codable & Sendable>: PayloadCaching, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: CachedPayload<Value>?
    private(set) var writes = 0
    private(set) var clears = 0

    init(seed: Value? = nil, capturedAt: Date = Date()) {
        if let seed { stored = CachedPayload(value: seed, capturedAt: capturedAt) }
    }

    func read() -> CachedPayload<Value>? {
        lock.withLock { stored }
    }

    func write(_ value: Value, at capturedAt: Date) {
        lock.withLock {
            stored = CachedPayload(value: value, capturedAt: capturedAt)
            writes += 1
        }
    }

    func clear() {
        lock.withLock {
            stored = nil
            clears += 1
        }
    }
}

/// A family of caches keyed by string, for the two stores whose cache depends
/// on what the screen is asking for — dividends by filter, news by ticker,
/// a series by symbol-and-range. Handing each key its own `FakePayloadCache` is
/// what lets a test assert that a per-ticker view does NOT read the unfiltered
/// one's file.
final class FakePayloadCacheFamily<Value: Codable & Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var caches: [String: FakePayloadCache<Value>] = [:]

    func cache(for key: String) -> FakePayloadCache<Value> {
        lock.withLock {
            if let existing = caches[key] { return existing }
            let made = FakePayloadCache<Value>()
            caches[key] = made
            return made
        }
    }

    /// The keys anything has actually asked for. A test asserting on cache
    /// separation reads this rather than guessing the naming scheme.
    var keys: [String] { lock.withLock { Array(caches.keys) } }

    func make() -> @Sendable (String) -> any PayloadCaching<Value> {
        { [self] key in cache(for: key) }
    }
}
