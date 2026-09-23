import Foundation

@testable import StockHODL

/// Builders for the generated contract types.
///
/// The contracts are wire mirrors with no defaults, so constructing one inline
/// in a test costs eleven arguments and buries the one field the test is about.
/// These put the defaults in one place and let each test name only what it
/// cares about — which is also what makes a failure readable.
enum LiveFixture {
    static func figure(_ text: String, _ direction: Direction = .gain) -> LiveFigure {
        LiveFigure(direction: direction, text: text)
    }

    static func holding(
        instrumentId: String,
        direction: Direction = .gain,
        price: String? = "182,40 USD",
        valuePLN: String? = "12 345,67 PLN",
        dayPct: LiveFigure? = nil,
        extended: ExtendedFigure? = nil,
        cachedPrice: CachedPrice? = nil
    ) -> LiveHolding {
        LiveHolding(
            cachedPrice: cachedPrice,
            dayPct: dayPct,
            direction: direction,
            extended: extended,
            instrumentId: instrumentId,
            price: price,
            unrealizedPct: "+12,30%",
            unrealizedPLN: "+1 234,00 PLN",
            unrealizedPLNRaw: "1234.00",
            valuePLN: valuePLN,
            valuePLNRaw: valuePLN == nil ? nil : "12345.67"
        )
    }

    static func summary(
        totalValue: String? = "23 708,11 PLN",
        partial: Bool = false,
        excluded: [String] = []
    ) -> LiveSummary {
        LiveSummary(
            dayChange: figure("+1,20%"),
            // The percent halves the widgets render on their own. Same figure
            // as the parenthesised half of `text` by contract, so the fixture
            // spells it the same way.
            dayChangePct: "+1,20%",
            excludedSymbols: excluded,
            partialDayChange: partial,
            totalChange: figure("+5,40%"),
            totalChangePct: "+5,40%",
            totalValue: totalValue,
            trend: nil
        )
    }

    static func market(
        status: MarketStatus = .marketStatusOpen,
        resumesAtMs: Int? = nil
    ) -> LiveMarket {
        LiveMarket(
            nextTransitionAtMs: nil,
            nextTransitionKind: nil,
            pollingResumesAtMs: resumesAtMs,
            serverNowMs: 1_760_000_000_000,
            status: status
        )
    }

    static func payload(
        status: MarketStatus = .marketStatusOpen,
        hasPollableSymbols: Bool = true,
        holdings: [LiveHolding]? = nil,
        scopes: [LiveScope] = [],
        totalValue: String? = "23 708,11 PLN"
    ) -> LivePayload {
        LivePayload(
            hasPollableSymbols: hasPollableSymbols,
            holdings: holdings ?? [holding(instrumentId: "i1")],
            market: market(status: status),
            scopes: scopes,
            summary: summary(totalValue: totalValue)
        )
    }

    static func staticHolding(
        instrumentId: String,
        symbol: String = "AAPL",
        oversold: Bool = false,
        trend: [TrendDay?]? = nil
    ) -> StaticHolding {
        StaticHolding(
            avgCost: "150,00 USD",
            costBasisPLN: "10000.00",
            currency: .usd,
            displayName: "Apple Inc.",
            instrumentId: instrumentId,
            oversold: oversold,
            quantity: "10",
            symbol: symbol,
            // Nil, not a fixture week: every suite that reads this is about
            // the figures, and a strip invented here would quietly become the
            // thing those tests assert against.
            trend: trend
        )
    }

    // MARK: - Instrument screen

    static func position(
        direction: Direction = .gain,
        oversold: Bool = false
    ) -> PositionFigures {
        PositionFigures(
            avgCost: "150,00 USD",
            costBasisPLN: "10 000,00 PLN",
            currency: .usd,
            direction: direction,
            oversold: oversold,
            quantity: "10",
            unrealizedPct: "+12,30%",
            unrealizedPLN: "+1 234,00 PLN",
            valuePLN: "12 345,67 PLN"
        )
    }

    static func transaction(
        id: String = "00000000-0000-0000-0000-000000000001",
        side: TransactionSide = .buy,
        tradeDate: String = "2026-03-04",
        portfolioId: String = "p1"
    ) -> TransactionRow {
        TransactionRow(
            currency: .usd,
            displayName: "Apple Inc.",
            exchange: "NASDAQ",
            fees: "1.50",
            fxRateToBase: "4.05",
            id: id,
            instrumentId: "i1",
            note: nil,
            portfolioId: portfolioId,
            portfolioName: "Main",
            price: "182.40",
            quantity: "10",
            side: side,
            symbol: "AAPL",
            tradeDate: tradeDate
        )
    }

    static func match(
        symbol: String = "AAPL",
        name: String = "Apple Inc.",
        exchange: String = "NASDAQ",
        currency: Currency? = .usd
    ) -> SymbolMatch {
        SymbolMatch(
            currency: currency,
            exchange: exchange,
            exchangeDisplay: exchange,
            name: name,
            symbol: symbol,
            type: .equity
        )
    }

    static func instrument(
        symbol: String = "AAPL",
        owned: Bool = true,
        watched: Bool = false,
        hasDividends: Bool = false,
        price: String? = "182,40 USD",
        cachedPrice: CachedPrice? = nil,
        dayStats: DayStats? = nil,
        transactions: [TransactionRow]? = nil,
        priceTargets: [PriceTarget] = [],
        targetStatus: TargetStatus? = nil
    ) -> InstrumentResponse {
        InstrumentResponse(
            about: About(
                description: nil,
                employees: nil,
                marketCap: nil,
                website: nil,
                week52: nil
            ),
            cachedPrice: cachedPrice,
            currency: .usd,
            dayPct: figure("+1,20%"),
            dayStats: dayStats ?? Self.dayStats(),
            displayName: "Apple Inc.",
            exchange: "NASDAQ",
            extended: nil,
            groups: [
                PortfolioGroup(portfolioId: "p1", portfolioName: "Main", summary: position()),
            ],
            hasDividends: hasDividends,
            instrumentId: "i1",
            owned: owned,
            position: owned ? position() : nil,
            price: price,
            priceTargets: priceTargets,
            symbol: symbol,
            targetStatus: targetStatus,
            transactions: transactions ?? [transaction()],
            watched: watched
        )
    }

    /// The session row, PRE-FORMATTED as the server sends it. A nil field is
    /// an absent one — never a fabricated zero.
    static func dayStats(
        prevClose: String? = "180,25 USD",
        dayOpen: String? = "181,00 USD",
        dayLow: String? = "180,10 USD",
        dayHigh: String? = "183,00 USD",
        volume: String? = "41 235 900",
        vwap: String? = "182,00 USD"
    ) -> DayStats {
        DayStats(
            dayHigh: dayHigh,
            dayLow: dayLow,
            dayOpen: dayOpen,
            prevClose: prevClose,
            volume: volume,
            vwap: vwap
        )
    }

    /// A short intraday series: two pre-market bars, then the regular session.
    /// Values are decimal strings, as they are on the wire.
    static func series(count: Int = 6) -> [ChartPoint] {
        (0..<count).map { index in
            ChartPoint(
                h: nil,
                l: nil,
                o: nil,
                p: index < 2 ? .pre : nil,
                r: nil,
                t: 1_760_000_000_000 + index * 300_000,
                v: "\(180 + index).50"
            )
        }
    }

    // MARK: - Watchlist

    static func watched(
        instrumentId: String = "i1",
        symbol: String = "AAPL",
        trend: [TrendDay?]? = nil
    ) -> WatchedItem {
        WatchedItem(
            currency: .usd,
            displayName: "Apple Inc.",
            instrumentId: instrumentId,
            symbol: symbol,
            trend: trend
        )
    }

    static func watchPayload(
        status: MarketStatus = .marketStatusOpen,
        hasPollableSymbols: Bool = true,
        items: [LiveWatchItem]? = nil
    ) -> WatchlistPayload {
        WatchlistPayload(
            hasPollableSymbols: hasPollableSymbols,
            items: items ?? [
                LiveWatchItem(
                    dayPct: figure("+1,20%"),
                    extended: nil,
                    instrumentId: "i1",
                    price: "182,40 USD",
                    target: nil,
                    targetGroup: TargetGroup.none
                ),
            ],
            market: market(status: status)
        )
    }

    static func bootstrap(
        live: LivePayload? = nil,
        portfolios: [Portfolio] = [Portfolio(id: "p1", name: "Main", sortOrder: 0, txCount: 4)],
        scopes: [StaticScope]? = nil,
        staticHoldings: [StaticHolding]? = nil
    ) -> BootstrapResponse {
        BootstrapResponse(
            live: live ?? payload(),
            portfolios: portfolios,
            scopes: scopes ?? [
                StaticScope(id: "p1", name: "Main", staticHoldings: [], txCount: 4),
            ],
            staticHoldings: staticHoldings ?? [staticHolding(instrumentId: "i1")],
            watchlist: []
        )
    }
}

// MARK: - Options

extension LiveFixture {
    static func optionLot(
        id: String = "11111111-1111-4111-8111-111111111111",
        quantityRaw: String = "2.00000000",
        entryPriceRaw: String = "3.50000000",
        tradeDate: String = "2026-08-10"
    ) -> OptionLotItem {
        OptionLotItem(
            entryPrice: "3,50 USD",
            entryPriceRaw: entryPriceRaw,
            fees: "1,02 USD",
            feesRaw: "1.02000000",
            id: id,
            quantity: "2",
            quantityRaw: quantityRaw,
            tradeDate: tradeDate,
            tradeDateLabel: "10 sie"
        )
    }

    /// One card. Defaults describe a healthy, quoted, unexpired call so a test
    /// names only the field it is about.
    static func optionCard(
        key: String = "O:AAPL260904C00220000",
        ticker: String = "O:AAPL260904C00220000",
        underlying: String = "AAPL",
        expirationDate: String = "2026-09-04",
        expired: Bool = false,
        daysToExpiry: Int = 21,
        hasQuote: Bool = true,
        valueRaw: String? = "1000.00000000",
        plRaw: String? = "300.00000000",
        lots: [OptionLotItem]? = nil,
        trend: [TrendDay?]? = nil
    ) -> OptionCardItem {
        let lotList = lots ?? [optionLot()]
        return OptionCardItem(
            breakEven: "223,50 USD",
            contractType: .call,
            day: hasQuote ? figure("+25,00%") : nil,
            dayBasisLabel: nil,
            dayPct: hasQuote ? figure("+25,00%") : nil,
            daysToExpiry: daysToExpiry,
            delta: hasQuote ? "0,64" : "—",
            entryIsAverage: lotList.count > 1,
            entryPrice: "3,50 USD",
            expirationDate: expirationDate,
            expired: expired,
            expiryLabel: "4 wrz 2026",
            fees: "1,02 USD",
            gamma: hasQuote ? "0,01" : "—",
            hasQuote: hasQuote,
            impliedVolatility: hasQuote ? "29,00%" : "—",
            key: key,
            lastTradeBeyondLookback: false,
            lastTradeLabel: "13 sie",
            lotCount: lotList.count,
            lots: lotList,
            noTrade: false,
            openInterest: hasQuote ? "1500" : "—",
            pl: hasQuote ? figure("+42,86%") : nil,
            plDirection: hasQuote ? .gain : .neutral,
            plPct: hasQuote ? "+42,86%" : "—",
            plRaw: plRaw,
            price: hasQuote ? "5,00 USD" : nil,
            priceIsEstimate: false,
            quantity: "2",
            strike: "220,00 USD",
            strikeLabel: "220",
            theta: hasQuote ? "-0,05" : "—",
            ticker: ticker,
            totalCost: "702,04 USD",
            // Nil for the same reason the holding fixture's is: these suites
            // are about the card's figures, and an invented strip would
            // quietly become what they assert against.
            trend: trend,
            underlying: underlying,
            valueRaw: valueRaw,
            vega: hasQuote ? "0,22" : "—"
        )
    }

    static func optionsPayload(
        items: [OptionCardItem]? = nil,
        status: MarketStatus = .marketStatusOpen,
        resumesAtMs: Int? = nil
    ) -> OptionsPayload {
        let cards = items ?? [optionCard()]
        let expired = cards.filter(\.expired).count
        return OptionsPayload(
            allSummary: summary(totalValue: "1 000,00 USD"),
            allSummaryNotes: [],
            expiredCount: expired,
            items: cards,
            market: market(status: status, resumesAtMs: resumesAtMs),
            summary: summary(totalValue: "1 000,00 USD"),
            summaryNotes: []
        )
    }
}

/// Wait for a condition instead of sleeping a guessed interval.
///
/// The stores start their fetches in UNSTRUCTURED tasks, so a test that
/// changes a property has to wait for the effect. A fixed `Task.sleep` passes
/// on an idle machine and fails on a busy one — a test that reports the load
/// average rather than the code — and it gets slower to no purpose as the
/// suite grows.
///
/// Only for waiting on something to HAPPEN. An assertion that nothing happens
/// cannot be polled for and keeps its sleep, where a longer wait only makes
/// the claim stronger.
/// Inherits the CALLER's isolation (`#isolation`) rather than demanding a
/// `@Sendable` closure: most of these suites are `@MainActor`, and the thing
/// being waited on is usually a property of a `@MainActor` store. A sendable
/// closure could not read one at all, which would push every such test back
/// onto a sleep.
///
/// The ceiling is a margin, not a measurement: the wait returns the moment the
/// condition holds, so a generous one costs nothing on a pass and only
/// lengthens a genuine failure. 2 s proved too tight while the full suite runs
/// hundreds of main-actor tests in parallel. Where a store offers a way to
/// await the work itself (`OptionFormStore.settleChain()`), prefer that.
func until(
    timeout: Duration = .seconds(10),
    isolation: isolated (any Actor)? = #isolation,
    _ condition: () -> Bool
) async {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !condition(), ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(5))
    }
}

/// The market gate's wall clock, held by the test. Whole seconds, so no
/// floating-point conversion is written here. `reads` counts gate checks: one
/// per pump tick that reached the gate, which is how a test sees ticks pass
/// without a sleep.
@MainActor
final class FakeGateClock {
    var seconds: Int
    private(set) var reads = 0

    init(seconds: Int) { self.seconds = seconds }

    func now() -> Date {
        reads += 1
        return Date(timeIntervalSince1970: TimeInterval(seconds))
    }
}
