import Foundation
import Testing

@testable import StockHODL

/// Ported case for case from the TypeScript suite retired on 2026-09-23; this
/// file is now the spec.
///
/// The comparator's contract: ISO-date ordering without parsing a date,
/// raw-decimal money ordering (never a formatted display string), unknown as
/// its own bucket sinking in BOTH directions, and the contract ticker as a
/// TOTAL tiebreak — the 60 s poll re-sorts on every response, so an unstable
/// order would look like cards shuffling themselves.
private func card(
    _ ticker: String,
    _ underlying: String,
    _ expiration: String,
    _ valueRaw: String? = "1",
    _ profitRaw: String? = "1",
    /// Defaults to the ticker so most fixtures read unchanged; pass it
    /// explicitly to model the DEGENERATE fallback, where two cards of one
    /// contract share a ticker and only the card key separates them.
    key: String? = nil
) -> OptionCardItem {
    LiveFixture.optionCard(
        key: key ?? ticker,
        ticker: ticker,
        underlying: underlying,
        expirationDate: expiration,
        valueRaw: valueRaw,
        plRaw: profitRaw
    )
}

private func sorted(_ rows: [OptionCardItem], _ sort: OptionsSort) -> [String] {
    sortOptionCards(rows, by: sort).map(\.ticker)
}

@Suite("Options sort — expiry")
struct OptionsSortExpiryTests {
    private let rows = [
        card("B", "AAPL", "2027-01-15"),
        card("A", "MSFT", "2026-08-21"),
        card("C", "NVDA", "2026-12-19"),
    ]

    @Test("expiry-asc puts the nearest expiry first")
    func expiryAsc() { #expect(sorted(rows, .expiryAsc) == ["A", "C", "B"]) }

    @Test("expiry-desc reverses it")
    func expiryDesc() { #expect(sorted(rows, .expiryDesc) == ["B", "C", "A"]) }

    /// `'2026-09-04' < '2026-10-01'` only holds with zero-padded ISO — the
    /// guard against anyone "simplifying" the payload's date format.
    @Test("orders across a month boundary lexicographically, not by digits")
    func lexicographic() {
        let dated = [card("Z", "AAPL", "2026-10-01"), card("Y", "AAPL", "2026-09-04")]
        #expect(sorted(dated, .expiryAsc) == ["Y", "Z"])
    }

    @Test("a same-day pair falls back to ticker ascending, both directions")
    func sameDayTieBreak() {
        let sameDay = [
            card("O:AAPL260904C00230000", "AAPL", "2026-09-04"),
            card("O:AAPL260904C00220000", "AAPL", "2026-09-04"),
        ]
        let expected = ["O:AAPL260904C00220000", "O:AAPL260904C00230000"]
        #expect(sorted(sameDay, .expiryAsc) == expected)
        #expect(sorted(sameDay, .expiryDesc) == expected)
    }
}

@Suite("Options sort — name")
struct OptionsSortNameTests {
    private let rows = [
        card("c", "NVDA", "2026-09-04"),
        card("a", "AAPL", "2027-01-15"),
        card("b", "MSFT", "2026-08-21"),
    ]

    @Test("name-asc orders by UNDERLYING A to Z, not by contract ticker")
    func nameAsc() { #expect(sorted(rows, .nameAsc) == ["a", "b", "c"]) }

    @Test("name-desc orders by underlying Z to A")
    func nameDesc() { #expect(sorted(rows, .nameDesc) == ["c", "b", "a"]) }

    @Test("equal underlyings tiebreak on ticker ascending")
    func equalUnderlyings() {
        let same = [card("O:AAPL2", "AAPL", "2027-01-15"), card("O:AAPL1", "AAPL", "2026-08-21")]
        #expect(sorted(same, .nameAsc) == ["O:AAPL1", "O:AAPL2"])
        #expect(sorted(same, .nameDesc) == ["O:AAPL1", "O:AAPL2"])
    }
}

@Suite("Options sort — money keys")
struct OptionsSortMoneyTests {
    // A negative, a zero and a positive: raw decimal ordering, never string.
    private let rows = [
        card("AAA", "AAA", "2026-09-04", "500.00000000", "0.00000000"),
        card("BBB", "BBB", "2026-09-04", "2000.00000000", "300.00000000"),
        card("CCC", "CCC", "2026-09-04", "90.00000000", "-1000.00000000"),
    ]

    @Test("value-desc puts the biggest position first")
    func valueDesc() { #expect(sorted(rows, .valueDesc) == ["BBB", "AAA", "CCC"]) }

    @Test("value-asc reverses it")
    func valueAsc() { #expect(sorted(rows, .valueAsc) == ["CCC", "AAA", "BBB"]) }

    @Test("profit-desc ranks the loss last, the zero in the middle")
    func profitDesc() { #expect(sorted(rows, .profitDesc) == ["BBB", "AAA", "CCC"]) }

    @Test("profit-asc puts the loss first")
    func profitAsc() { #expect(sorted(rows, .profitAsc) == ["CCC", "AAA", "BBB"]) }

    @Test("a 9 vs 10 digit-count trap orders numerically, not lexically")
    func digitTrap() {
        let trap = [
            card("AAA", "AAA", "2026-09-04", "9.00000000", "9.00000000"),
            card("BBB", "BBB", "2026-09-04", "10.00000000", "10.00000000"),
        ]
        #expect(sorted(trap, .valueDesc) == ["BBB", "AAA"])
        #expect(sorted(trap, .valueAsc) == ["AAA", "BBB"])
    }

    /// `0.100000000000000001 == 0.1` in IEEE doubles; `Decimal` separates
    /// them. This is the test that fails the moment anyone reaches for
    /// the Double initialiser in the comparator.
    @Test("orders a high-precision pair a float comparison would tie")
    func precision() {
        let precise = [
            card("AAA", "AAA", "2026-09-04", "0.1", "0.1"),
            card("BBB", "BBB", "2026-09-04", "0.100000000000000001", "0.100000000000000001"),
        ]
        #expect(sorted(precise, .valueDesc) == ["BBB", "AAA"])
        #expect(sorted(precise, .valueAsc) == ["AAA", "BBB"])
    }

    @Test("equal values written at different scales tie and fall back to ticker")
    func scaleInsensitive() {
        let scaled = [
            card("BBB", "BBB", "2026-09-04", "100", "0"),
            card("AAA", "AAA", "2026-09-04", "100.00000000", "0.00000000"),
        ]
        #expect(sorted(scaled, .valueDesc) == ["AAA", "BBB"])
        #expect(sorted(scaled, .valueAsc) == ["AAA", "BBB"])
    }
}

@Suite("Options sort — the unknown bucket sinks in BOTH directions")
struct OptionsSortUnknownTests {
    private let rows = [
        card("AAA", "AAA", "2026-09-04", "500.00000000", "500.00000000"),
        // Even a LOSS outranks unknown: −1000 is a number, nil is not a zero.
        card("LOSS", "LOSS", "2026-09-04", "90.00000000", "-1000.00000000"),
        card("UNK", "UNK", "2026-09-04", nil, nil),
    ]

    @Test("value-desc: an unpriceable contract last")
    func valueDesc() { #expect(sorted(rows, .valueDesc) == ["AAA", "LOSS", "UNK"]) }

    @Test("value-asc: STILL last — never the smallest")
    func valueAsc() { #expect(sorted(rows, .valueAsc) == ["LOSS", "AAA", "UNK"]) }

    @Test("profit-desc: unknown last, never among the losses")
    func profitDesc() { #expect(sorted(rows, .profitDesc) == ["AAA", "LOSS", "UNK"]) }

    @Test("profit-asc: STILL last, below the -1000 loss")
    func profitAsc() { #expect(sorted(rows, .profitAsc) == ["LOSS", "AAA", "UNK"]) }
}

@Suite("Options sort — totality and the menu")
struct OptionsSortTotalityTests {
    /// The DEGENERATE case: two cards of ONE contract share a ticker, so only
    /// the card key separates them. Without that final fallback the order
    /// would rest on input order and the 60 s poll could reshuffle them.
    @Test("cards sharing a ticker are settled by card key")
    func degenerateGroup() {
        let rows = [
            card("O:AAPL1", "AAPL", "2026-09-04", "1", "1", key: "O:AAPL1#b"),
            card("O:AAPL1", "AAPL", "2026-09-04", "1", "1", key: "O:AAPL1#a"),
        ]
        #expect(sortOptionCards(rows, by: .expiryAsc).map(\.key) == ["O:AAPL1#a", "O:AAPL1#b"])
        #expect(sortOptionCards(rows, by: .valueDesc).map(\.key) == ["O:AAPL1#a", "O:AAPL1#b"])
    }

    /// The eight keys and their order are the web's `OPTION_SORT_OPTIONS`
    /// verbatim — expiry first, then the six Holdings entries in their exact
    /// existing wording, so one vocabulary spans both screens.
    @Test("the eight orderings mirror the web, in order")
    func mirrorsWeb() {
        #expect(OptionsSort.allCases.map(\.rawValue) == [
            "expiry-asc", "expiry-desc", "name-asc", "name-desc",
            "value-desc", "value-asc", "profit-desc", "profit-asc",
        ])
        #expect(OptionsSort.fallback == .expiryAsc)
    }

    /// The options chart's five ranges — `1D`/`5D` must NOT be offered: the
    /// marks are daily, so those tabs would always draw nothing.
    @Test("the chart offers five daily ranges and no intraday one")
    func fiveRanges() {
        #expect(OptionsChartRange.allCases.map(\.rawValue) == ["1M", "6M", "YTD", "1Y", "ALL"])
        #expect(OptionsChartRange.fallback == .oneMonth)
        #expect(OptionsChartRange.allCases.allSatisfy { $0.granularity == .daily })
    }
}
