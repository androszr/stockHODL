import Foundation
import Testing

@testable import StockHODL

/// Ported case for case from the TypeScript suite retired on 2026-09-23; this
/// file is now the spec.
///
/// The two clients sort the same portfolio and the user compares them, so
/// these are not "some sort tests" — they are the web suite, restated. Any
/// case that exists there and not here is a way the two lists can disagree.
private struct Row {
    let symbol: String
    let valueRaw: String?
    let profitRaw: String?
}

private func row(_ symbol: String, _ valueRaw: String?, _ profitRaw: String?) -> Row {
    Row(symbol: symbol, valueRaw: valueRaw, profitRaw: profitRaw)
}

private func symbols(_ rows: [Row], _ sort: HoldingsSort) -> [String] {
    sortHoldings(rows, by: sort) {
        HoldingSortKeys(symbol: $0.symbol, valueRaw: $0.valueRaw, profitRaw: $0.profitRaw)
    }
    .map(\.symbol)
}

@Suite("Holdings sort — money keys")
struct HoldingsSortMoneyTests {
    // 2000 > 500 > -1000, deliberately mixing signs and digit counts: raw
    // decimal comparison, not string ordering.
    private let priced = [
        row("AAA", "500.00000000", "500.00000000"),
        row("BBB", "2000.00000000", "2000.00000000"),
        row("CCC", "-1000.00000000", "-1000.00000000"),
    ]

    @Test("value-desc puts the biggest position first")
    func valueDesc() {
        #expect(symbols(priced, .valueDesc) == ["BBB", "AAA", "CCC"])
    }

    @Test("value-asc reverses it")
    func valueAsc() {
        #expect(symbols(priced, .valueAsc) == ["CCC", "AAA", "BBB"])
    }

    @Test("profit-desc orders by raw unrealized PLN, negative below smaller positive")
    func profitDesc() {
        #expect(symbols(priced, .profitDesc) == ["BBB", "AAA", "CCC"])
    }

    @Test("profit-asc puts the loss first")
    func profitAsc() {
        #expect(symbols(priced, .profitAsc) == ["CCC", "AAA", "BBB"])
    }

    /// The trap that catches a string comparison: "10" < "9" lexically.
    @Test("a 9 vs 10 digit-count trap orders numerically, not lexically")
    func digitCountTrap() {
        let rows = [row("AAA", "9.00000000", "9.00000000"), row("BBB", "10.00000000", "10.00000000")]
        #expect(symbols(rows, .valueDesc) == ["BBB", "AAA"])
        #expect(symbols(rows, .valueAsc) == ["AAA", "BBB"])
    }
}

@Suite("Holdings sort — name keys")
struct HoldingsSortNameTests {
    private let rows = [row("MSFT", nil, nil), row("AAPL", "1", "1"), row("GOOG", "2", "2")]

    @Test("name-asc orders by symbol A to Z")
    func nameAsc() {
        #expect(symbols(rows, .nameAsc) == ["AAPL", "GOOG", "MSFT"])
    }

    @Test("name-desc orders by symbol Z to A")
    func nameDesc() {
        #expect(symbols(rows, .nameDesc) == ["MSFT", "GOOG", "AAPL"])
    }
}

@Suite("Holdings sort — the unknown bucket sinks in BOTH directions")
struct HoldingsSortUnknownTests {
    private let withUnknown = [
        row("AAA", "500.00000000", "500.00000000"),
        // Even a LOSS outranks unknown: -1000 is a number, nil is not a zero.
        row("LOSS", "-1000.00000000", "-1000.00000000"),
        row("UNK", nil, nil),
    ]

    @Test("value-desc: unknown last")
    func valueDesc() {
        #expect(symbols(withUnknown, .valueDesc) == ["AAA", "LOSS", "UNK"])
    }

    @Test("value-asc: unknown STILL last — never the smallest")
    func valueAsc() {
        #expect(symbols(withUnknown, .valueAsc) == ["LOSS", "AAA", "UNK"])
    }

    @Test("profit-desc: unknown last")
    func profitDesc() {
        #expect(symbols(withUnknown, .profitDesc) == ["AAA", "LOSS", "UNK"])
    }

    @Test("profit-asc: unknown STILL last")
    func profitAsc() {
        #expect(symbols(withUnknown, .profitAsc) == ["LOSS", "AAA", "UNK"])
    }

    @Test("two unknown rows order by symbol, both directions")
    func twoUnknowns() {
        let rows = [row("ZZZ", nil, nil), row("AAA", nil, nil), row("MID", "1", "1")]
        #expect(symbols(rows, .valueDesc) == ["MID", "AAA", "ZZZ"])
        #expect(symbols(rows, .valueAsc) == ["MID", "AAA", "ZZZ"])
    }

    /// Swift-only: `dec()` returns nil where decimal.js reaches the same
    /// outcome through a NaN comparison. An unparseable figure is exactly as
    /// unknown as an absent one, and must never become a zero.
    @Test("an unparseable figure joins the unknown bucket, it does not become zero")
    func unparseableIsUnknown() {
        let rows = [row("JUNK", "not-a-number", "not-a-number"), row("LOSS", "-5", "-5")]
        #expect(symbols(rows, .valueDesc) == ["LOSS", "JUNK"])
        #expect(symbols(rows, .valueAsc) == ["LOSS", "JUNK"])
    }
}

@Suite("Holdings sort — totality and purity")
struct HoldingsSortTotalityTests {
    @Test("equal money keys tie-break by symbol ascending")
    func tieBreak() {
        let rows = [row("BBB", "100.00000000", "5"), row("AAA", "100.00000000", "5")]
        #expect(symbols(rows, .valueDesc) == ["AAA", "BBB"])
        #expect(symbols(rows, .valueAsc) == ["AAA", "BBB"])
    }

    @Test("the input is not mutated")
    func doesNotMutate() {
        let rows = [row("BBB", "1", "1"), row("AAA", "2", "2")]
        _ = symbols(rows, .valueDesc)
        #expect(rows.map(\.symbol) == ["BBB", "AAA"])
    }

    /// Why the comparator takes `valueRaw`/`unrealizedPLNRaw` and NEVER the
    /// formatted twins, stated as a test because the failure mode is silent.
    ///
    /// `dec()` parses the longest valid PREFIX — deliberately, see its own
    /// doc and `strictDecimal` in TransactionInput.swift — so a pl-PL display
    /// string does not come back nil and land in the unknown bucket where it
    /// would be visible. "2 000,00" comes back as **2**, and the biggest
    /// position in the portfolio quietly sorts below a 5 zł one.
    ///
    /// There is no way for the comparator to detect this at runtime: 2 is a
    /// perfectly good number. The only defence is the call site passing the
    /// raw field, which is what DashboardView and HoldingsView do.
    @Test("a formatted amount silently parses to its first digits — hence raw keys only")
    func formattedWouldMisSortSilently() {
        #expect(dec("2 000,00") == 2)
        #expect(dec("2000.00") == 2000)

        let rows = [row("BIG", "2 000,00", nil), row("SMALL", "5.00", nil)]
        // The wrong-by-construction ordering, pinned so the reason this
        // matters cannot be argued away later.
        #expect(symbols(rows, .valueDesc) == ["SMALL", "BIG"])
    }
}

@Suite("Holdings sort — the menu and its memory")
struct HoldingsSortPreferenceTests {
    /// The six keys and their order are the web's `SORT_OPTIONS` verbatim.
    @Test("the six orderings mirror the web, in order")
    func mirrorsWeb() {
        #expect(HoldingsSort.allCases.map(\.rawValue) == [
            "name-asc", "name-desc", "value-desc", "value-asc", "profit-desc", "profit-asc",
        ])
        #expect(HoldingsSort.fallback == .valueDesc)
    }

    @Test("a stored value is honoured only while it is still one of the six")
    func parsesStored() {
        #expect(HoldingsSort.parse(stored: "profit-asc") == .profitAsc)
        #expect(HoldingsSort.parse(stored: "value-sideways") == nil)
        #expect(HoldingsSort.parse(stored: nil) == nil)
    }

    /// Holdings and the Dashboard remember SEPARATELY — writing one must not
    /// move the other.
    @Test("the two screens remember independently")
    func separateMemories() {
        let defaults = UserDefaults(suiteName: "sort-tests-\(UUID().uuidString)")!

        HoldingsSort.nameAsc.remember(for: .holdings, in: defaults)
        #expect(HoldingsSort.remembered(for: .holdings, in: defaults) == .nameAsc)
        #expect(HoldingsSort.remembered(for: .dashboard, in: defaults) == .valueDesc)

        HoldingsSort.profitDesc.remember(for: .dashboard, in: defaults)
        #expect(HoldingsSort.remembered(for: .holdings, in: defaults) == .nameAsc)
        #expect(HoldingsSort.remembered(for: .dashboard, in: defaults) == .profitDesc)
    }

    /// A key dropped between two builds must fall back, not crash and not
    /// silently order by something else.
    @Test("an unknown stored key falls back rather than sticking")
    func unknownStoredFallsBack() {
        let defaults = UserDefaults(suiteName: "sort-tests-\(UUID().uuidString)")!
        defaults.set("value-sideways", forKey: HoldingsSort.Screen.holdings.rawValue)
        #expect(HoldingsSort.remembered(for: .holdings, in: defaults) == .valueDesc)
    }
}
