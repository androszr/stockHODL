import Foundation
import Observation

/// A stock opened from search, remembered only as a label. Exchange, currency
/// and type are deliberately absent — fabricating them would write fiction
/// into a watchlist row, so a recent cannot grow binoculars.
struct RecentSymbol: Codable, Equatable, Sendable {
    let symbol: String
    let name: String
}

/// The last eight stocks opened from search, newest first.
///
/// Device-local: `UserDefaults` via an injected seam, never the process-wide
/// `standard` except as the default argument. Wiped on sign-out so a second
/// account never sees the first account's lookups. Nothing here is a secret.
@MainActor
@Observable
final class RecentSymbolsStore {
    private static let key = "search.recents"
    private static let cap = 8

    private let defaults: UserDefaults
    private(set) var items: [RecentSymbol]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.items = Self.load(from: defaults)
    }

    /// Front-insert. An existing ticker moves to the front and refreshes its
    /// stored name — exact string match; the server emits canonical uppercase.
    func record(symbol: String, name: String) {
        items.removeAll { $0.symbol == symbol }
        items.insert(RecentSymbol(symbol: symbol, name: name), at: 0)
        if items.count > Self.cap {
            items = Array(items.prefix(Self.cap))
        }
        persist()
    }

    /// Empties memory AND removes the key, so a fresh store over the same
    /// defaults does not resurrect the list.
    func purge() {
        items = []
        defaults.removeObject(forKey: Self.key)
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        defaults.set(data, forKey: Self.key)
    }

    /// Garbage in the suite is an empty list, never a crash.
    private static func load(from defaults: UserDefaults) -> [RecentSymbol] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([RecentSymbol].self, from: data)) ?? []
    }
}
