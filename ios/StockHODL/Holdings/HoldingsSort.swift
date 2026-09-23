import Foundation

/// Holdings list ordering. The TypeScript original was retired on 2026-09-23; `HoldingsSortTests` is the spec.
///
/// Pure and storage-free, exactly like its web twin: the comparator only ever
/// sees the RAW decimal-string sort keys (`LiveHolding.valuePLNRaw` /
/// `unrealizedPLNRaw`), never a pl-PL formatted display string — comparing
/// those would need the parse-back non-negotiable #1 forbids.
///
/// The six orderings and their order are the web's `SORT_OPTIONS` verbatim.
/// The same portfolio must not offer a different menu on two screens.
enum HoldingsSort: String, CaseIterable, Sendable {
    case nameAsc = "name-asc"
    case nameDesc = "name-desc"
    case valueDesc = "value-desc"
    case valueAsc = "value-asc"
    case profitDesc = "profit-desc"
    case profitAsc = "profit-asc"

    /// The menu row. Matches the web's `label`.
    var label: String {
        switch self {
        case .nameAsc: "Name A→Z"
        case .nameDesc: "Name Z→A"
        case .valueDesc: "Value high→low"
        case .valueAsc: "Value low→high"
        case .profitDesc: "Profit high→low"
        case .profitAsc: "Profit low→high"
        }
    }

    /// The collapsed form on the button itself — the web's `short`.
    var short: String {
        switch self {
        case .nameAsc: "Name ↑"
        case .nameDesc: "Name ↓"
        case .valueDesc: "Value ↓"
        case .valueAsc: "Value ↑"
        case .profitDesc: "Profit ↓"
        case .profitAsc: "Profit ↑"
        }
    }

    /// What VoiceOver reads — the arrows above are glyphs, and "Name up arrow"
    /// is not what the ordering means. The web's `spoken`.
    var spoken: String {
        switch self {
        case .nameAsc: "name, A to Z"
        case .nameDesc: "name, Z to A"
        case .valueDesc: "value, high to low"
        case .valueAsc: "value, low to high"
        case .profitDesc: "profit, high to low"
        case .profitAsc: "profit, low to high"
        }
    }

    static let fallback: HoldingsSort = .valueDesc

    /// A stored string is only honoured if it is still one of the six keys —
    /// the web's `parseStoredSort`. A removed ordering must not resurrect
    /// itself from an old install's preferences.
    static func parse(stored raw: String?) -> HoldingsSort? {
        guard let raw else { return nil }
        return HoldingsSort(rawValue: raw)
    }
}

/// The three keys the comparator reads — raw decimal strings, never display.
struct HoldingSortKeys {
    let symbol: String
    let valueRaw: String?
    let profitRaw: String?
}

/// Non-mutating sort. Rules, ported rule for rule:
/// - `name-*`: plain `<`/`>` on `symbol` — tickers are ASCII, and a localized
///   collation would order the same portfolio differently on a Polish phone
///   than in the browser beside it.
/// - `value-*` / `profit-*`: `Decimal` comparison of the raw strings.
/// - A nil money key sorts AFTER every non-nil key in BOTH directions —
///   unknown is its own bucket, never zero (a −1 000 zł loss sorts below an
///   unknown profit, not above it).
/// - Equal keys and nil-vs-nil fall through to `symbol` ascending, so the
///   order is total and stable.
func sortHoldings<T>(
    _ items: [T],
    by sort: HoldingsSort,
    keys: (T) -> HoldingSortKeys
) -> [T] {
    // Sorted by an index-carrying tuple rather than `sorted(by:)` alone:
    // Swift's sort is NOT guaranteed stable, and the web's is. The final
    // symbol tiebreak makes the order total anyway, but two rows sharing a
    // symbol would otherwise be free to swap on every live frame.
    items.enumerated()
        .map { (offset: $0.offset, item: $0.element, keys: keys($0.element)) }
        .sorted { a, b in
            let cmp = compareSortKeys(a.keys, b.keys, sort)
            return cmp == 0 ? a.offset < b.offset : cmp < 0
        }
        .map(\.item)
}

private func bySymbolAsc(_ a: String, _ b: String) -> Int {
    a < b ? -1 : (a > b ? 1 : 0)
}

func compareSortKeys(
    _ a: HoldingSortKeys,
    _ b: HoldingSortKeys,
    _ sort: HoldingsSort
) -> Int {
    if sort == .nameAsc { return bySymbolAsc(a.symbol, b.symbol) }
    if sort == .nameDesc { return -bySymbolAsc(a.symbol, b.symbol) }

    let descending = sort == .valueDesc || sort == .profitDesc
    let onValue = sort == .valueDesc || sort == .valueAsc
    let ka = onValue ? a.valueRaw : a.profitRaw
    let kb = onValue ? b.valueRaw : b.profitRaw

    // The nil bucket sinks before any numeric comparison, both directions.
    // A present-but-unparseable string joins that bucket rather than becoming
    // a zero: it is exactly as unknown as an absent one, and the web reaches
    // the same outcome by a longer road (decimal.js answers `null` for a NaN
    // comparison, which its comparator then treats as no ordering).
    switch (ka.flatMap(dec), kb.flatMap(dec)) {
    case (nil, nil):
        return bySymbolAsc(a.symbol, b.symbol)
    case (nil, _):
        return 1
    case (_, nil):
        return -1
    case let (da?, db?):
        if da == db { return bySymbolAsc(a.symbol, b.symbol) }
        let cmp = da < db ? -1 : 1
        return descending ? -cmp : cmp
    }
}

extension HoldingsSort {
    /// Which screen's memory this is. Holdings and the Dashboard remember
    /// SEPARATELY — the web's `SORT_STORAGE_KEY` vs `DASHBOARD_SORT_STORAGE_KEY`
    /// — because the two screens are asked different questions: a dashboard is
    /// scanned by size, a list is often read by name.
    ///
    /// `UserDefaults` rather than the App Group snapshot, on the `ChartRange`
    /// precedent: a preference is not account data, so a sign-out purge must
    /// not take it. It is passed in rather than reached for, because
    /// `UserDefaults.standard` is process-wide and a test that writes it would
    /// decide what an unrelated test opens on.
    enum Screen: String, Sendable {
        case holdings = "holdings.sort"
        case dashboard = "dashboard.sort"
    }

    static func remembered(
        for screen: Screen,
        in defaults: UserDefaults = .standard
    ) -> HoldingsSort {
        parse(stored: defaults.string(forKey: screen.rawValue)) ?? fallback
    }

    func remember(for screen: Screen, in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: screen.rawValue)
    }
}
