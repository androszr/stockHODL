import Foundation

/// Options tab ordering. The TypeScript original was retired on 2026-09-23; `OptionsSortTests` is the spec.
///
/// A TWIN of `HoldingsSort` rather than a shared comparator, exactly as on the
/// web: options sort by an expiry date holdings have no concept of, and "name"
/// means the UNDERLYING rather than a ticker. Forcing one comparator would put
/// an always-nil `expirationDate` on `HoldingSortKeys`. The picker IS shared —
/// `SortMenu` is generic over this protocol.
///
/// The comparator only ever sees RAW decimal strings (`valueRaw` / `plRaw`),
/// never `price` or `pl.text`, which are pl-PL formatted and could only be
/// compared by the parse-back non-negotiable #1 forbids.
enum OptionsSort: String, CaseIterable, Sendable {
    case expiryAsc = "expiry-asc"
    case expiryDesc = "expiry-desc"
    case nameAsc = "name-asc"
    case nameDesc = "name-desc"
    case valueDesc = "value-desc"
    case valueAsc = "value-asc"
    case profitDesc = "profit-desc"
    case profitAsc = "profit-asc"

    var label: String {
        switch self {
        case .expiryAsc: "Expiry soonest→latest"
        case .expiryDesc: "Expiry latest→soonest"
        case .nameAsc: "Name A→Z"
        case .nameDesc: "Name Z→A"
        case .valueDesc: "Value high→low"
        case .valueAsc: "Value low→high"
        case .profitDesc: "Profit high→low"
        case .profitAsc: "Profit low→high"
        }
    }

    var short: String {
        switch self {
        case .expiryAsc: "Expiry ↑"
        case .expiryDesc: "Expiry ↓"
        case .nameAsc: "Name ↑"
        case .nameDesc: "Name ↓"
        case .valueDesc: "Value ↓"
        case .valueAsc: "Value ↑"
        case .profitDesc: "Profit ↓"
        case .profitAsc: "Profit ↑"
        }
    }

    var spoken: String {
        switch self {
        case .expiryAsc: "expiry, soonest to latest"
        case .expiryDesc: "expiry, latest to soonest"
        case .nameAsc: "name, A to Z"
        case .nameDesc: "name, Z to A"
        case .valueDesc: "value, high to low"
        case .valueAsc: "value, low to high"
        case .profitDesc: "profit, high to low"
        case .profitAsc: "profit, low to high"
        }
    }

    /// Soonest expiry on top — the contract that needs a decision first.
    static let fallback: OptionsSort = .expiryAsc

    /// Which screen's memory this is. The Options tab and the Dashboard's
    /// options strip remember SEPARATELY, the Holdings/Dashboard precedent:
    /// reordering one must never reorder the other.
    enum Screen: String, Sendable {
        case options = "options.sort"
        case dashboard = "dashboard.options.sort"
    }

    static func remembered(
        for screen: Screen = .options,
        in defaults: UserDefaults = .standard
    ) -> OptionsSort {
        guard let raw = defaults.string(forKey: screen.rawValue) else { return fallback }
        return OptionsSort(rawValue: raw) ?? fallback
    }

    func remember(for screen: Screen = .options, in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: screen.rawValue)
    }
}

/// Non-mutating sort. Rules, mirroring the web comparator:
/// - `expiry-*`: plain `<`/`>` on the ISO `expirationDate` — never a parsed
///   date, never `daysToExpiry` (a number re-derived per render).
/// - `name-*`: plain `<`/`>` on `underlying` — ASCII, and a localized
///   collation would order the same book differently on a Polish phone.
/// - `value-*` / `profit-*`: `Decimal` comparison of the raw strings.
/// - A nil money key (i.e. `hasQuote == false`) sorts AFTER every non-nil key
///   in BOTH directions — unknown is its own bucket, never zero, so an
///   unpriceable contract never ranks among the losses.
/// - EVERY branch, ties included, falls through to `ticker` then `key`: the
///   order is total, so the 60 s poll cannot reshuffle equal cards.
func sortOptionCards(_ items: [OptionCardItem], by sort: OptionsSort) -> [OptionCardItem] {
    items.enumerated()
        .sorted { a, b in
            let cmp = compareOptionCards(a.element, b.element, sort)
            return cmp == 0 ? a.offset < b.offset : cmp < 0
        }
        .map(\.element)
}

private func asc(_ a: String, _ b: String) -> Int {
    a < b ? -1 : (a > b ? 1 : 0)
}

/// Ticker groups a contract's cards together; the card key settles them.
private func tieBreak(_ a: OptionCardItem, _ b: OptionCardItem) -> Int {
    let cmp = asc(a.ticker, b.ticker)
    return cmp != 0 ? cmp : asc(a.key, b.key)
}

func compareOptionCards(
    _ a: OptionCardItem,
    _ b: OptionCardItem,
    _ sort: OptionsSort
) -> Int {
    switch sort {
    case .expiryAsc, .expiryDesc:
        let cmp = asc(a.expirationDate, b.expirationDate)
        if cmp != 0 { return sort == .expiryDesc ? -cmp : cmp }
        return tieBreak(a, b)

    case .nameAsc, .nameDesc:
        let cmp = asc(a.underlying, b.underlying)
        if cmp != 0 { return sort == .nameDesc ? -cmp : cmp }
        return tieBreak(a, b)

    case .valueDesc, .valueAsc, .profitDesc, .profitAsc:
        let descending = sort == .valueDesc || sort == .profitDesc
        let byValue = sort == .valueDesc || sort == .valueAsc
        let ka = byValue ? a.valueRaw : a.plRaw
        let kb = byValue ? b.valueRaw : b.plRaw

        // The nil bucket sinks before any numeric comparison, both directions.
        switch (ka.flatMap(dec), kb.flatMap(dec)) {
        case (nil, nil):
            return tieBreak(a, b)
        case (nil, _):
            return 1
        case (_, nil):
            return -1
        case let (da?, db?):
            if da == db { return tieBreak(a, b) }
            let cmp = da < db ? -1 : 1
            return descending ? -cmp : cmp
        }
    }
}
