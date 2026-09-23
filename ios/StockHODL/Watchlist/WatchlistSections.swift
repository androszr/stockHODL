import Foundation

/// One rendered group of the Watchlist grid: an optional header and the
/// static rows that file under it, in the SERVER's order.
/// Not `Equatable`: the generated `WatchedItem` is `Codable` only, and the
/// tests compare ids and titles rather than whole rows.
struct WatchlistSection: Identifiable {
    /// Stable across recompositions — the group is the identity, so a stock
    /// moving between groups animates as a move, not a rebuild of everything.
    let id: String
    /// Nil renders no header at all — the unlabeled single-section cases.
    let title: String?
    let items: [WatchedItem]
}

/// How the server-sorted live payload becomes sections of static rows — the
/// whole of that question, Foundation-only like `TradeMarkers.swift`, so the
/// join is testable without mounting SwiftUI and the view cannot quietly
/// discard the server sort by iterating `store.items` again.
enum WatchlistSections {
    /// Joins the server-sorted `live.items` against the static list by
    /// `instrumentId`. The rules, each pinned by a test:
    ///
    /// - the LIVE order is the display order — the server sorted it, and the
    ///   stream recomposes it per tick, so re-deriving it here would be a
    ///   second implementation waiting to disagree;
    /// - static leftovers (quotes still in flight) append to the `none`
    ///   section in insertion order — a row must never vanish because its
    ///   figures have not arrived;
    /// - live items whose static row is gone (unwatched since the baseline)
    ///   are dropped;
    /// - nil live payload ⇒ ONE unlabeled section (the offline screen);
    /// - everything in `none` ⇒ no headers — a watchlist with no target
    ///   lines looks exactly as it did before this feature.
    static func build(items: [WatchedItem], live: WatchlistPayload?) -> [WatchlistSection] {
        guard !items.isEmpty else { return [] }
        guard let live else {
            return [WatchlistSection(id: "all", title: nil, items: items)]
        }

        // The static identity per instrument. First write wins, defensively —
        // the server never sends duplicate watch rows.
        let byId = Dictionary(items.map { ($0.instrumentId, $0) }, uniquingKeysWith: { a, _ in a })

        var near: [WatchedItem] = []
        var set: [WatchedItem] = []
        var none: [WatchedItem] = []
        var seen = Set<String>()
        for liveItem in live.items {
            guard let item = byId[liveItem.instrumentId],
                  seen.insert(liveItem.instrumentId).inserted else { continue }
            switch liveItem.targetGroup {
            case .near: near.append(item)
            case .targetGroupSet: set.append(item)
            case .none: none.append(item)
            }
        }
        for item in items where !seen.contains(item.instrumentId) {
            none.append(item)
        }

        if near.isEmpty && set.isEmpty {
            // Nothing has a waiting line — today's screen, unchanged.
            return none.isEmpty ? [] : [WatchlistSection(id: "all", title: nil, items: none)]
        }

        var sections: [WatchlistSection] = []
        if !near.isEmpty {
            sections.append(WatchlistSection(id: "near", title: "Near a target", items: near))
        }
        if !set.isEmpty {
            sections.append(WatchlistSection(id: "set", title: "Has a target", items: set))
        }
        if !none.isEmpty {
            sections.append(WatchlistSection(id: "none", title: "No target", items: none))
        }
        return sections
    }
}
