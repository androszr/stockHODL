import Foundation
import Testing

@testable import StockHODL

/// Where a trade sits on a line — the whole feature, and the one part of it
/// that can be got wrong invisibly.
///
/// The day key is what these mostly pin. A daily point's `t` is an anchor the
/// server chose (midnight UTC for instrument and portfolio bars, noon UTC for
/// options); read through the New York calendar, midnight UTC names the day
/// BEFORE and every marker lands one bar to the left, which looks almost
/// right. Intraday points are real instants and the server groups them by NY
/// date, so those must NOT be read as UTC. Both directions are asserted.
struct TradeMarkersTests {
    // MARK: - Fixtures

    /// 2026-08-12T00:00:00Z — the midnight anchor of a daily bar.
    private let aug12Midnight = 1_786_492_800_000
    /// 2026-08-11T00:00:00Z.
    private let aug11Midnight = 1_786_406_400_000
    /// 2026-08-13T00:00:00Z.
    private let aug13Midnight = 1_786_579_200_000
    /// 2026-08-14T00:00:00Z.
    private let aug14Midnight = 1_786_665_600_000
    /// 2026-08-12T12:00:00Z — the options series' noon anchor.
    private let aug12Noon = 1_786_536_000_000
    /// 2026-08-12 20:00 New York, which is 2026-08-13T00:00Z.
    private let aug12Evening = 1_786_579_200_000
    /// 2026-08-13 04:00 New York, which is 2026-08-13T08:00Z.
    private let aug13Morning = 1_786_608_000_000

    /// `x` and `y` are geometry and nothing here reads them back except the
    /// "the mark takes the POINT's y" assertion, so they stay simple.
    private func point(_ index: Int, _ t: Int, _ raw: String, y: Double = 1) -> PlotPoint {
        PlotPoint(
            index: index,
            t: t,
            x: 0,
            y: y,
            raw: raw,
            phase: nil,
            candle: nil
        )
    }

    private func trade(
        _ id: String,
        _ date: String,
        side: TransactionSide = .buy,
        price: String? = nil
    ) -> TradeMark {
        TradeMark(
            id: id,
            label: "AAPL",
            side: side,
            tradeDate: date,
            unitPriceRaw: price,
            quantityText: "12",
            priceText: "231,10 USD",
            dateText: date
        )
    }

    // MARK: - The day key

    @Test("A daily point is keyed by its UTC date, midnight anchor")
    func dailyMidnightAnchorKeysAsUTC() {
        #expect(TradeMarkers.dayKey(ofPointAt: aug12Midnight, granularity: .daily) == "2026-08-12")
    }

    @Test("A daily point is keyed by its UTC date, noon anchor too")
    func dailyNoonAnchorKeysAsUTC() {
        #expect(TradeMarkers.dayKey(ofPointAt: aug12Noon, granularity: .daily) == "2026-08-12")
    }

    /// The bug this exists to prevent, stated as the inequality it is: reading
    /// a midnight-UTC daily point through the NY calendar names the day before.
    @Test("Reading a daily point as a NY date would name the previous day")
    func nyCalendarWouldNameThePreviousDay() {
        #expect(NYCalendar.isoDate(atEpochMs: aug12Midnight) == "2026-08-11")
        #expect(NYCalendar.isoDate(atEpochMs: aug12Midnight)
            != TradeMarkers.dayKey(ofPointAt: aug12Midnight, granularity: .daily))
    }

    @Test("An intraday point is keyed by its New York date")
    func intradayKeysAsNewYork() {
        #expect(TradeMarkers.dayKey(ofPointAt: aug12Evening, granularity: .intraday) == "2026-08-12")
        #expect(TradeMarkers.dayKey(ofPointAt: aug13Morning, granularity: .intraday) == "2026-08-13")
    }

    // MARK: - Placement

    @Test("A daily trade lands on the point whose UTC date matches")
    func dailyTradeLandsOnItsOwnDay() {
        let plotted = [
            point(0, aug11Midnight, "100"),
            point(1, aug12Midnight, "110"),
            point(2, aug13Midnight, "120"),
        ]

        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12")],
            on: plotted,
            granularity: .daily,
            matchOnPrice: false
        )

        #expect(placement.marks.count == 1)
        #expect(placement.marks[0].pointIndex == 1)
        #expect(placement.marks[0].y == plotted[1].y)
        #expect(placement.unplacedInWindow == 0)
    }

    @Test("Among a day's moments, the price closest to what was paid wins")
    func intradayMatchesOnPrice() {
        let plotted = [
            point(0, 1_786_541_400_000, "228.00"),
            point(1, 1_786_543_200_000, "231.00"),
            point(2, 1_786_546_800_000, "235.00"),
            point(3, 1_786_550_400_000, "240.00"),
        ]

        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12", price: "231.10")],
            on: plotted,
            granularity: .intraday,
            matchOnPrice: true
        )

        #expect(placement.marks.count == 1)
        #expect(placement.marks[0].pointIndex == 1)
    }

    @Test("Two moments at the same price: the earlier one wins")
    func priceTiesGoToTheEarlierMoment() {
        let plotted = [
            point(0, 1_786_541_400_000, "228.00"),
            point(1, 1_786_543_200_000, "231.00"),
            point(2, 1_786_546_800_000, "231.00"),
        ]

        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12", price: "231.00")],
            on: plotted,
            granularity: .intraday,
            matchOnPrice: true
        )

        #expect(placement.marks[0].pointIndex == 1)
    }

    /// A `raw` that will not parse is skipped, never read as zero — a zero
    /// would be nearest to nothing and would win every comparison.
    @Test("An unparsable point is skipped rather than treated as zero")
    func unparsableCandidateIsSkipped() {
        let plotted = [
            point(0, 1_786_541_400_000, "not-a-number"),
            point(1, 1_786_543_200_000, "231.00"),
            point(2, 1_786_546_800_000, "260.00"),
        ]

        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12", price: "231.10")],
            on: plotted,
            granularity: .intraday,
            matchOnPrice: true
        )

        #expect(placement.marks.count == 1)
        #expect(placement.marks[0].pointIndex == 1)
    }

    @Test("Without price matching, a busy day marks its LAST point")
    func withoutPriceMatchingTheDayEndsOnItsLastPoint() {
        let plotted = [
            point(0, 1_786_541_400_000, "228.00"),
            point(1, 1_786_543_200_000, "231.00"),
            point(2, 1_786_546_800_000, "235.00"),
        ]

        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12", price: "228.00")],
            on: plotted,
            granularity: .intraday,
            matchOnPrice: false
        )

        #expect(placement.marks[0].pointIndex == 2)
    }

    @Test("A trade with no unit price falls back to the day's last point")
    func missingUnitPriceFallsBackRatherThanDropping() {
        let plotted = [
            point(0, 1_786_541_400_000, "228.00"),
            point(1, 1_786_543_200_000, "231.00"),
        ]

        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12", price: nil)],
            on: plotted,
            granularity: .intraday,
            matchOnPrice: true
        )

        #expect(placement.marks.count == 1)
        #expect(placement.marks[0].pointIndex == 1)
    }

    // MARK: - The window's edges

    @Test("Trades outside the plotted span are not marked and not counted")
    func tradesOutsideTheWindowAreSimplyAbsent() {
        let plotted = [
            point(0, aug11Midnight, "100"),
            point(1, aug12Midnight, "110"),
        ]

        let placement = TradeMarkers.place(
            [trade("before", "2026-07-01"), trade("after", "2026-09-01")],
            on: plotted,
            granularity: .daily,
            matchOnPrice: false
        )

        #expect(placement.marks.isEmpty)
        #expect(placement.unplacedInWindow == 0)
    }

    @Test("A trade on a day with no reading is counted, not hidden")
    func aHolidayInsideTheWindowIsCounted() {
        let plotted = [
            point(0, aug11Midnight, "100"),
            // 2026-08-12 has no reading at all.
            point(1, aug13Midnight, "120"),
            point(2, aug14Midnight, "130"),
        ]

        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12")],
            on: plotted,
            granularity: .daily,
            matchOnPrice: false
        )

        #expect(placement.marks.isEmpty)
        #expect(placement.unplacedInWindow == 1)
    }

    // MARK: - Grouping

    @Test("Two trades on one point become ONE mark, in plot order")
    func tradesOnOnePointAreGrouped() {
        let plotted = [
            point(0, aug11Midnight, "100"),
            point(1, aug12Midnight, "110"),
        ]

        let placement = TradeMarkers.place(
            [trade("first", "2026-08-12"), trade("second", "2026-08-12")],
            on: plotted,
            granularity: .daily,
            matchOnPrice: false
        )

        #expect(placement.marks.count == 1)
        #expect(placement.marks[0].trades.map(\.id) == ["first", "second"])
        #expect(placement.marks[0].id == "1")
    }

    /// A buy and a sell on one day is still one mark — and the glyph rule
    /// resolves it as mixed, which is neither triangle and neither colour.
    @Test("A buy and a sell on one point make a mixed mark")
    func aBuyAndASellOnOnePointAreMixed() {
        let plotted = [
            point(0, aug11Midnight, "100"),
            point(1, aug12Midnight, "110"),
        ]

        let placement = TradeMarkers.place(
            [trade("b", "2026-08-12", side: .buy), trade("s", "2026-08-12", side: .sell)],
            on: plotted,
            granularity: .daily,
            matchOnPrice: false
        )

        #expect(placement.marks.count == 1)
        #expect(placement.marks[0].trades.map(\.side) == [.buy, .sell])
        #expect(TradeMarkGlyph.composition(of: placement.marks[0]) == .mixed)
        #expect(TradeMarkGlyph.symbol(for: placement.marks[0]) == "circle.fill")
    }

    @Test("An all-buy mark points up and an all-sell mark points down")
    func glyphCarriesTheSideAsShape() {
        let plotted = [point(0, aug11Midnight, "100"), point(1, aug12Midnight, "110")]

        let buys = TradeMarkers.place(
            [trade("b", "2026-08-12", side: .buy)],
            on: plotted, granularity: .daily, matchOnPrice: false
        )
        let sells = TradeMarkers.place(
            [trade("s", "2026-08-12", side: .sell)],
            on: plotted, granularity: .daily, matchOnPrice: false
        )

        #expect(TradeMarkGlyph.symbol(for: buys.marks[0]) == "arrowtriangle.up.fill")
        #expect(TradeMarkGlyph.symbol(for: sells.marks[0]) == "arrowtriangle.down.fill")
    }

    @Test("An empty plot places nothing and counts nothing")
    func anEmptyPlotIsNotACrash() {
        let placement = TradeMarkers.place(
            [trade("t1", "2026-08-12")],
            on: [],
            granularity: .daily,
            matchOnPrice: false
        )

        #expect(placement.marks.isEmpty)
        #expect(placement.unplacedInWindow == 0)
    }

    @Test("The callout words a trade the way its own row does")
    func calloutLineIsTheRowsWording() {
        let mark = PlacedTradeMark(
            id: "1",
            trades: [
                TradeMark(
                    id: "t1",
                    label: "AAPL",
                    side: .buy,
                    tradeDate: "2026-08-12",
                    unitPriceRaw: "231.10",
                    quantityText: "12 @ 231,10 USD",
                    priceText: nil,
                    dateText: "2026-08-12"
                )
            ],
            x: 1,
            y: 1,
            pointIndex: 1
        )

        #expect(TradeMarkCallout.line(mark.trades[0]) == "BUY · AAPL · 12 @ 231,10 USD · 2026-08-12")
    }

    @Test("A share trade's mark is labelled with its ticker")
    func instrumentMarkCarriesTicker() {
        let marks = TradeMark.from([LiveFixture.transaction(id: "a")])
        #expect(marks.map(\.label) == ["AAPL"])
        #expect(TradeMarkCallout.line(marks[0]).hasPrefix("BUY · AAPL · "))
    }

    @Test("An option lot's mark is labelled with the card's headline")
    func optionMarkCarriesContractHeadline() {
        let card = LiveFixture.optionCard()
        let marks = TradeMark.fromLots([card])
        #expect(marks.count == 1)
        #expect(marks[0].label == OptionCardView.headline(for: card))
        #expect(marks[0].label.hasPrefix("AAPL $"))
        #expect(marks[0].label.hasSuffix(" CALL"))
        #expect(TradeMarkCallout.line(marks[0]).contains(" · \(marks[0].label) · "))
    }
}

/// Which trades the Holdings chart is allowed to mark.
///
/// The predicate is separate from the screen precisely so it can be pinned
/// here: the chip's "All" is a sentinel, and `LiveStore.selectedScopeID` is nil
/// until `start()` restores the remembered chip. Both mean ALL, and reading
/// nil as "the portfolio whose id is nil" would draw the all-portfolios series
/// with no markers on it at all for every frame before the restore.
@MainActor
struct HoldingsTradeScopeTests {
    private let rows = [
        LiveFixture.transaction(id: "a", portfolioId: "p1"),
        LiveFixture.transaction(id: "b", portfolioId: "p2"),
        LiveFixture.transaction(id: "c", portfolioId: "p1")
    ]

    @Test("The All chip carries every portfolio's trades")
    func allScopeKeepsEverything() {
        #expect(HoldingsView.scoped(rows, to: LiveStore.allScopeID).map(\.id) == ["a", "b", "c"])
    }

    @Test("No chip restored yet is still All, not a portfolio with no id")
    func nilScopeKeepsEverything() {
        #expect(HoldingsView.scoped(rows, to: nil).map(\.id) == ["a", "b", "c"])
    }

    @Test("One portfolio carries only its own trades")
    func oneScopeFilters() {
        #expect(HoldingsView.scoped(rows, to: "p1").map(\.id) == ["a", "c"])
        #expect(HoldingsView.scoped(rows, to: "p2").map(\.id) == ["b"])
    }
}
