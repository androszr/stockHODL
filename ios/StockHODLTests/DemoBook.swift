import Foundation

@testable import StockHODL

/// The invented book the README pictures are drawn from.
///
/// Every figure is a string the way the server would have formatted it
/// (`fmtMoney` / `fmtPct` / `signedMoney`, pl-PL, U+00A0 grouping). Nothing
/// here is computed from a price on the device, and nothing here is a real
/// holding. The day is Tuesday 22 September 2026, after the cash close.
enum DemoBook {
    static let synthetic = true

    /// 2026-09-22 20:00 UTC. The market bar reads the status, not this clock.
    static let closeMs = 1_790_107_200_000

    /// Far enough ahead that a poll loop armed by `start()` does not fetch
    /// again while a picture is being taken. The status bar does not show it:
    /// there is no `nextTransition`.
    static let resumesAtMs = 2_000_000_000_000

    static let fxRate = "3,6520"

    // MARK: - The book

    static let holdings: [Row] = [
        Row(symbol: "AAPL", name: "Apple", instrumentId: "i-aapl",
            quantity: "12", priceUSD: "228,40", valuePLN: "10 009,40", valueRaw: "10009.40",
            dayPct: "+1,15%", dayDirection: .gain,
            unrealized: "+1 085,40", unrealizedRaw: "1085.40", unrealizedPct: "+12,16%",
            portfolio: .core),
        Row(symbol: "MSFT", name: "Microsoft", instrumentId: "i-msft",
            quantity: "8", priceUSD: "418,20", valuePLN: "12 218,13", valueRaw: "12218.13",
            dayPct: "+0,62%", dayDirection: .gain,
            unrealized: "+2 240,00", unrealizedRaw: "2240.00", unrealizedPct: "+22,45%",
            portfolio: .core),
        Row(symbol: "NVDA", name: "NVIDIA", instrumentId: "i-nvda",
            quantity: "15", priceUSD: "124,80", valuePLN: "6 836,54", valueRaw: "6836.54",
            dayPct: "-1,40%", dayDirection: .loss,
            unrealized: "+860,00", unrealizedRaw: "860.00", unrealizedPct: "+14,39%",
            portfolio: .core),
        Row(symbol: "AVGO", name: "Broadcom", instrumentId: "i-avgo",
            quantity: "6", priceUSD: "176,50", valuePLN: "3 867,47", valueRaw: "3867.47",
            dayPct: "+2,10%", dayDirection: .gain,
            unrealized: "+410,00", unrealizedRaw: "410.00", unrealizedPct: "+11,86%",
            portfolio: .core),
        Row(symbol: "COST", name: "Costco", instrumentId: "i-cost",
            quantity: "4", priceUSD: "912,10", valuePLN: "13 323,96", valueRaw: "13323.96",
            dayPct: "-0,22%", dayDirection: .loss,
            unrealized: "+1 760,00", unrealizedRaw: "1760.00", unrealizedPct: "+15,22%",
            portfolio: .core),
        Row(symbol: "JPM", name: "JPMorgan", instrumentId: "i-jpm",
            quantity: "10", priceUSD: "218,30", valuePLN: "7 972,32", valueRaw: "7972.32",
            dayPct: "+0,35%", dayDirection: .gain,
            unrealized: "+980,00", unrealizedRaw: "980.00", unrealizedPct: "+14,02%",
            portfolio: .income),
        Row(symbol: "XOM", name: "Exxon Mobil", instrumentId: "i-xom",
            quantity: "20", priceUSD: "112,40", valuePLN: "8 209,70", valueRaw: "8209.70",
            dayPct: "+0,80%", dayDirection: .gain,
            unrealized: "+1 120,00", unrealizedRaw: "1120.00", unrealizedPct: "+15,80%",
            portfolio: .income),
        Row(symbol: "KO", name: "Coca-Cola", instrumentId: "i-ko",
            quantity: "30", priceUSD: "71,20", valuePLN: "7 800,67", valueRaw: "7800.67",
            dayPct: "+0,15%", dayDirection: .gain,
            unrealized: "+964,60", unrealizedRaw: "964.60", unrealizedPct: "+14,11%",
            portfolio: .income),
    ]

    enum Book: String {
        case core = "p-core"
        case income = "p-income"
        var name: String { self == .core ? "Core" : "Income" }
    }

    struct Row {
        let symbol: String
        let name: String
        let instrumentId: String
        let quantity: String
        let priceUSD: String
        let valuePLN: String
        let valueRaw: String
        let dayPct: String
        let dayDirection: Direction
        let unrealized: String
        let unrealizedRaw: String
        let unrealizedPct: String
        let portfolio: Book
    }

    /// Every display string, for the privacy check. Machine names are the
    /// Python guard's job; this is the book itself.
    static var auditBlob: String {
        holdings.map {
            [$0.symbol, $0.name, $0.valuePLN, $0.priceUSD, $0.unrealized].joined(separator: " ")
        }.joined(separator: "\n")
            + "\n" + holdingsSummary.totalValue!
            + "\n" + optionsSummary.totalValue!
    }

    // MARK: - Money strings

    /// `fmtMoney` on pl-PL: groups and the currency gap are U+00A0.
    static func money(_ grouped: String, _ currency: String) -> String {
        grouped.replacingOccurrences(of: " ", with: "\u{00A0}") + "\u{00A0}" + currency
    }

    static func zł(_ grouped: String) -> String { money(grouped, "zł") }
    static func usd(_ grouped: String) -> String { money(grouped, "USD") }

    /// `signedMoney`: a gain grows a plus, a loss already carries the minus
    /// `fmtMoney` printed.
    static func signed(_ grouped: String, _ currency: String, gain: Bool) -> String {
        let bare = grouped.replacingOccurrences(of: "+", with: "").replacingOccurrences(of: "-", with: "")
        let body = money(bare, currency)
        if grouped.hasPrefix("-") || !gain { return "-" + body }
        return "+" + body
    }

    static func figure(_ text: String, _ direction: Direction) -> LiveFigure {
        LiveFigure(direction: direction, text: text)
    }

    static func summary(
        value: String,
        day: String,
        dayPct: String,
        total: String,
        totalPct: String,
        dayDirection: Direction = .gain,
        totalDirection: Direction = .gain
    ) -> LiveSummary {
        LiveSummary(
            dayChange: figure(day, dayDirection),
            dayChangePct: dayPct,
            excludedSymbols: [],
            partialDayChange: false,
            totalChange: figure(total, totalDirection),
            totalChangePct: totalPct,
            totalValue: value,
            trend: week
        )
    }

    /// Five sessions, the lights along the summary and the tiles.
    static let week: [TrendDay?] = [
        TrendDay(date: "2026-09-16", direction: .gain, level: 2, pct: "0.40"),
        TrendDay(date: "2026-09-17", direction: .gain, level: 3, pct: "0.90"),
        TrendDay(date: "2026-09-18", direction: .loss, level: 1, pct: "-0.20"),
        TrendDay(date: "2026-09-19", direction: .gain, level: 2, pct: "0.55"),
        TrendDay(date: "2026-09-22", direction: .gain, level: 2, pct: "0.36"),
    ]

    static let holdingsSummary = summary(
        value: zł("70 238,19"),
        day: "\(signed("+252,34", "zł", gain: true)) (+0,36%)",
        dayPct: "+0,36%",
        total: "\(signed("+9 420,00", "zł", gain: true)) (+15,49%)",
        totalPct: "+15,49%"
    )

    static let optionsSummary = summary(
        value: usd("2 195,00"),
        day: "\(signed("+42,00", "USD", gain: true)) (+1,95%)",
        dayPct: "+1,95%",
        total: "\(signed("+310,00", "USD", gain: true)) (+16,45%)",
        totalPct: "+16,45%"
    )

    static func market(status: MarketStatus = .closed) -> LiveMarket {
        LiveMarket(
            nextTransitionAtMs: nil,
            nextTransitionKind: nil,
            pollingResumesAtMs: resumesAtMs,
            serverNowMs: closeMs,
            status: status
        )
    }

    // MARK: - Live payload

    static func liveHolding(_ row: Row) -> LiveHolding {
        LiveHolding(
            cachedPrice: nil,
            dayPct: figure(row.dayPct, row.dayDirection),
            direction: .gain,
            extended: nil,
            instrumentId: row.instrumentId,
            price: usd(row.priceUSD),
            unrealizedPct: row.unrealizedPct,
            unrealizedPLN: signed(row.unrealized, "zł", gain: true),
            unrealizedPLNRaw: row.unrealizedRaw,
            valuePLN: zł(row.valuePLN),
            valuePLNRaw: row.valueRaw
        )
    }

    static func staticHolding(_ row: Row) -> StaticHolding {
        StaticHolding(
            avgCost: usd(row.priceUSD),
            costBasisPLN: row.valueRaw,
            currency: .usd,
            displayName: row.name,
            instrumentId: row.instrumentId,
            oversold: false,
            quantity: row.quantity,
            symbol: row.symbol,
            trend: week
        )
    }

    static func scopeSummary(value: String, day: String, dayPct: String) -> LiveSummary {
        summary(value: zł(value), day: "\(signed(day, "zł", gain: true)) (\(dayPct))",
                dayPct: dayPct, total: "\(signed("+1,00", "zł", gain: true)) (+1,00%)", totalPct: "+1,00%")
    }

    static var livePayload: LivePayload {
        let rows = holdings.map(liveHolding)
        return LivePayload(
            hasPollableSymbols: true,
            holdings: rows,
            market: market(),
            scopes: [
                LiveScope(
                    holdings: holdings.filter { $0.portfolio == .core }.map(liveHolding),
                    id: Book.core.rawValue,
                    summary: scopeSummary(value: "46 255,50", day: "+146,00", dayPct: "+0,32%")
                ),
                LiveScope(
                    holdings: holdings.filter { $0.portfolio == .income }.map(liveHolding),
                    id: Book.income.rawValue,
                    summary: scopeSummary(value: "23 982,69", day: "+106,34", dayPct: "+0,45%")
                ),
            ],
            summary: holdingsSummary
        )
    }

    static var bootstrap: BootstrapResponse {
        BootstrapResponse(
            live: livePayload,
            portfolios: [
                Portfolio(id: Book.core.rawValue, name: Book.core.name, sortOrder: 0, txCount: 6),
                Portfolio(id: Book.income.rawValue, name: Book.income.name, sortOrder: 1, txCount: 4),
            ],
            scopes: [
                StaticScope(id: Book.core.rawValue, name: Book.core.name, staticHoldings: [], txCount: 6),
                StaticScope(id: Book.income.rawValue, name: Book.income.name, staticHoldings: [], txCount: 4),
            ],
            staticHoldings: holdings.map(staticHolding),
            watchlist: []
        )
    }

    // MARK: - Options

    static func optionCard(
        key: String,
        underlying: String,
        expirationDate: String,
        expiryLabel: String,
        days: Int,
        strikeLabel: String,
        strike: String,
        quantity: String,
        entry: String,
        price: String,
        valueRaw: String,
        plRaw: String,
        plText: String,
        plPct: String,
        dayText: String,
        dayPct: String,
        dayDirection: Direction,
        totalCost: String,
        breakEven: String
    ) -> OptionCardItem {
        let lot = LiveFixture.optionLot(
            id: "lot-\(underlying.lowercased())",
            quantityRaw: quantity == "2" ? "2.00000000" : "1.00000000",
            entryPriceRaw: "1.00000000",
            tradeDate: "2026-06-02"
        )
        return OptionCardItem(
            breakEven: breakEven,
            contractType: .call,
            day: figure(dayText, dayDirection),
            dayBasisLabel: nil,
            dayPct: figure(dayPct, dayDirection),
            daysToExpiry: days,
            delta: "0,42",
            entryIsAverage: false,
            entryPrice: entry,
            expirationDate: expirationDate,
            expired: false,
            expiryLabel: expiryLabel,
            fees: usd("1,30"),
            gamma: "0,02",
            hasQuote: true,
            impliedVolatility: "24,00%",
            key: key,
            lastTradeBeyondLookback: false,
            lastTradeLabel: "22 wrz",
            lotCount: 1,
            lots: [lot],
            noTrade: false,
            openInterest: "1 240",
            pl: figure(plText, .gain),
            plDirection: .gain,
            plPct: plPct,
            plRaw: plRaw,
            price: price,
            priceIsEstimate: false,
            quantity: quantity,
            strike: strike,
            strikeLabel: strikeLabel,
            theta: "-0,04",
            ticker: key,
            totalCost: totalCost,
            trend: week,
            underlying: underlying,
            valueRaw: valueRaw,
            vega: "0,18"
        )
    }

    static var optionCards: [OptionCardItem] {
        [
            optionCard(
                key: "O:AAPL261016C00240000", underlying: "AAPL",
                expirationDate: "2026-10-16", expiryLabel: "16 paź 2026", days: 24,
                strikeLabel: "240", strike: usd("240,00"), quantity: "2",
                entry: usd("4,80"), price: usd("6,40"), valueRaw: "1280.00",
                plRaw: "320.00", plText: signed("+320,00", "USD", gain: true), plPct: "+33,33%",
                dayText: signed("+86,00", "USD", gain: true), dayPct: "+7,20%", dayDirection: .gain,
                totalCost: usd("961,30"), breakEven: usd("244,81")
            ),
            optionCard(
                key: "O:NVDA261120C00140000", underlying: "NVDA",
                expirationDate: "2026-11-20", expiryLabel: "20 lis 2026", days: 59,
                strikeLabel: "140", strike: usd("140,00"), quantity: "1",
                entry: usd("8,10"), price: usd("9,15"), valueRaw: "915.00",
                plRaw: "105.00", plText: signed("+105,00", "USD", gain: true), plPct: "+12,96%",
                dayText: signed("-44,00", "USD", gain: false), dayPct: "-4,59%", dayDirection: .loss,
                totalCost: usd("811,30"), breakEven: usd("148,11")
            ),
        ]
    }

    static var optionsPayload: OptionsPayload {
        OptionsPayload(
            allSummary: optionsSummary,
            allSummaryNotes: [],
            expiredCount: 0,
            items: optionCards,
            market: market(),
            summary: optionsSummary,
            summaryNotes: []
        )
    }

    // MARK: - Market strip

    static func spark(_ values: [String]) -> [ChartPoint] {
        values.enumerated().map { index, value in
            ChartPoint(h: nil, l: nil, o: nil, p: nil, r: nil, t: closeMs - (values.count - index) * 900_000, v: value)
        }
    }

    static var marketStrip: MarketStripPayload {
        MarketStripPayload(
            fx: CurrencyTile(
                caption: "PLN per 1 USD",
                dayPct: figure("+0,08%", .gain),
                key: .usdpln,
                last: fxRate,
                pairLabel: "USD/PLN",
                spark: spark(["3.6410", "3.6460", "3.6440", "3.6505", "3.6520"]),
                trend: week
            ),
            market: market(),
            tiles: [
                IndexTile(
                    dayPct: figure("+0,42%", .gain), indexName: "S&P 500", key: .spy,
                    last: usd("562,18"), proxySymbol: "SPY",
                    spark: spark(["558.40", "559.10", "560.80", "561.40", "562.18"]), trend: week
                ),
                IndexTile(
                    dayPct: figure("+0,71%", .gain), indexName: "Nasdaq", key: .qqq,
                    last: usd("487,60"), proxySymbol: "QQQ",
                    spark: spark(["482.20", "483.40", "485.10", "486.80", "487.60"]), trend: week
                ),
                IndexTile(
                    dayPct: figure("-0,19%", .loss), indexName: "Dow", key: .dia,
                    last: usd("418,35"), proxySymbol: "DIA",
                    spark: spark(["420.10", "419.40", "418.90", "418.20", "418.35"]), trend: week
                ),
            ]
        )
    }

    // MARK: - Charts

    static func points(_ pairs: [(Int, String)]) -> [ChartPoint] {
        pairs.map { ChartPoint(h: nil, l: nil, o: nil, p: nil, r: nil, t: $0.0, v: $0.1) }
    }

    /// The session that just closed, one point every fifteen minutes.
    static var sessionLine: SeriesPayload {
        let values = [
            "69985.85", "69840.20", "70010.40", "70190.00", "70040.60",
            "70310.20", "70220.40", "70110.00", "70380.50", "70238.19",
        ]
        let start = closeMs - (values.count - 1) * 900_000
        return SeriesPayload(
            anchorDate: "2026-09-22",
            estimatedFrom: nil,
            excludedSymbols: [],
            partialDays: 0,
            points: points(values.enumerated().map { (start + $0.offset * 900_000, $0.element) })
        )
    }

    static var appleLine: SeriesPayload {
        let values = ["224.80", "225.40", "224.10", "226.30", "227.05", "226.40", "227.90", "228.40"]
        let start = closeMs - (values.count - 1) * 1_800_000
        return SeriesPayload(
            anchorDate: "2026-09-22",
            estimatedFrom: nil,
            excludedSymbols: [],
            partialDays: 0,
            points: points(values.enumerated().map { (start + $0.offset * 1_800_000, $0.element) })
        )
    }

    static var optionsLine: SeriesPayload {
        let values = ["1880.00", "1920.00", "2050.00", "2110.00", "2080.00", "2140.00", "2160.00", "2195.00"]
        let day = 86_400_000
        let start = closeMs - (values.count - 1) * day
        return SeriesPayload(
            anchorDate: "2026-09-22",
            estimatedFrom: nil,
            excludedSymbols: [],
            partialDays: 0,
            points: points(values.enumerated().map { (start + $0.offset * day, $0.element) })
        )
    }

    // MARK: - Apple's page

    static var apple: InstrumentResponse {
        let row = holdings[0]
        let position = PositionFigures(
            avgCost: usd("203,63"),
            costBasisPLN: zł("8 924,00"),
            currency: .usd,
            direction: .gain,
            oversold: false,
            quantity: "12",
            unrealizedPct: "+12,16%",
            unrealizedPLN: signed("+1 085,40", "zł", gain: true),
            valuePLN: zł(row.valuePLN)
        )
        return InstrumentResponse(
            about: About(
                description: "Makes phones, computers and services. This page is the invented position, not a company filing.",
                employees: nil,
                marketCap: nil,
                website: "https://example.com",
                week52: nil
            ),
            cachedPrice: nil,
            currency: .usd,
            dayPct: figure(row.dayPct, row.dayDirection),
            dayStats: DayStats(
                dayHigh: usd("229,10"),
                dayLow: usd("224,10"),
                dayOpen: usd("224,80"),
                prevClose: usd("225,80"),
                volume: "48 120 000",
                vwap: usd("226,90")
            ),
            displayName: "Apple",
            exchange: "NASDAQ",
            extended: nil,
            groups: [
                PortfolioGroup(portfolioId: Book.core.rawValue, portfolioName: Book.core.name, summary: position),
            ],
            hasDividends: true,
            instrumentId: row.instrumentId,
            owned: true,
            position: position,
            price: usd(row.priceUSD),
            priceTargets: [],
            symbol: "AAPL",
            targetStatus: nil,
            transactions: [
                TransactionRow(
                    currency: .usd, displayName: "Apple", exchange: "NASDAQ", fees: "1.00",
                    fxRateToBase: "3.6520", id: "tx-aapl-1", instrumentId: row.instrumentId,
                    note: nil, portfolioId: Book.core.rawValue, portfolioName: Book.core.name,
                    price: "198.40", quantity: "8", side: .buy, symbol: "AAPL", tradeDate: "2026-03-12"
                ),
                TransactionRow(
                    currency: .usd, displayName: "Apple", exchange: "NASDAQ", fees: "1.00",
                    fxRateToBase: "3.6520", id: "tx-aapl-2", instrumentId: row.instrumentId,
                    note: nil, portfolioId: Book.core.rawValue, portfolioName: Book.core.name,
                    price: "214.10", quantity: "4", side: .buy, symbol: "AAPL", tradeDate: "2026-06-02"
                ),
            ],
            watched: false
        )
    }

    // MARK: - Day report

    static func mover(_ symbol: String, _ name: String, _ amount: String, gain: Bool, share: String, pct: String) -> MoverElement {
        MoverElement(
            barShare: share,
            contribution: MoverContribution(direction: gain ? .gain : .loss, text: signed(amount, "zł", gain: gain)),
            displayName: name,
            pricePct: pct,
            symbol: symbol
        )
    }

    static var dayReport: DayReportResponse {
        let lineValues = ["68110.00", "68840.00", "69220.00", "68650.00", "69480.00", "69985.85", "70238.19"]
        let day = 86_400_000
        let start = closeMs - (lineValues.count - 1) * day
        return DayReportResponse(
            benchmarks: [
                DayReportBenchmark(dayPct: "+0,42%", direction: .gain, extendedKind: nil, extendedPct: nil, indexName: "S&P 500", proxySymbol: "SPY"),
                DayReportBenchmark(dayPct: "+0,71%", direction: .gain, extendedKind: nil, extendedPct: nil, indexName: "Nasdaq", proxySymbol: "QQQ"),
                DayReportBenchmark(dayPct: "-0,19%", direction: .loss, extendedKind: nil, extendedPct: nil, indexName: "Dow", proxySymbol: "DIA"),
            ],
            day: "2026-09-22",
            dayLabel: "Tuesday, 22 September 2026",
            events: DayReportEvents(earningsCaption: "Earnings dates appear in the written report.", items: []),
            figures: DayReportFigures(
                dayChange: FiguresDayReportSignedDisplay(direction: .gain, text: signed("+252,34", "zł", gain: true)),
                dayChangePct: "+0,36%",
                excludedSymbols: [],
                holdings: PurpleDayReportFigurePart(
                    dayChange: PurpleDayReportSignedDisplay(direction: .gain, text: signed("+252,34", "zł", gain: true)),
                    dayChangePct: "+0,36%",
                    valueAtClose: zł("70 238,19")
                ),
                options: FluffyDayReportFigurePart(
                    dayChange: FluffyDayReportSignedDisplay(direction: .gain, text: signed("+153,38", "zł", gain: true)),
                    dayChangePct: "+1,95%",
                    valueAtClose: usd("2 195,00")
                ),
                optionsDayChangeUSD: signed("+42,00", "USD", gain: true),
                optionsNote: "Options stay in dollars. They are not added to the złoty total.",
                optionsRelation: .amplified,
                partial: false,
                partialSymbols: [],
                positionCount: 8,
                source: .stored,
                status: .ready,
                valueAtClose: zł("70 238,19")
            ),
            headlines: [],
            isLatest: true,
            kind: .close,
            movers: [
                mover("AAPL", "Apple", "+115,11", gain: true, share: "100", pct: "+1,15%"),
                mover("NVDA", "NVIDIA", "-95,71", gain: false, share: "83", pct: "-1,40%"),
                mover("AVGO", "Broadcom", "+81,22", gain: true, share: "71", pct: "+2,10%"),
                mover("MSFT", "Microsoft", "+75,75", gain: true, share: "66", pct: "+0,62%"),
            ],
            narrative: DayReportNarrative(
                events: [
                    DayReportNarrativeEvent(date: "2026-09-24", symbol: "AVGO", title: "Earnings, after the close"),
                    DayReportNarrativeEvent(date: "2026-09-22", symbol: nil, title: "Cash session closed higher"),
                ],
                eventsNarrative: "Broadcom reports on Thursday, after the close.",
                macroNarrative: "The dollar was a touch firmer against the złoty, at 3,6520.",
                portfolioNarrative: "Costco is still the largest line. Apple and Broadcom carried the day; NVIDIA gave some of last week back. The two calls finished up 42 dollars, and that book stays in dollars on its own.",
                sources: [
                    DayReportSource(title: "Session recap", url: "https://example.com/session"),
                ],
                staleFigures: false,
                status: .ready,
                todayLine: "Watch Broadcom's report on Thursday."
            ),
            nearestDay: nil,
            nextDay: nil,
            optionMovers: [
                OptionMoverElement(
                    barShare: "100",
                    contribution: OptionMoverContribution(direction: .gain, text: signed("+86,00", "USD", gain: true)),
                    displayName: "AAPL 240 C",
                    pricePct: "+7,20%",
                    symbol: "AAPL"
                ),
                OptionMoverElement(
                    barShare: "51",
                    contribution: OptionMoverContribution(direction: .loss, text: signed("-44,00", "USD", gain: false)),
                    displayName: "NVDA 140 C",
                    pricePct: "-4,59%",
                    symbol: "NVDA"
                ),
            ],
            prevDay: "2026-09-19",
            recap: nil,
            scopeId: nil,
            scopes: [],
            segments: DayReportSegments(close: .ready, morning: .ready),
            status: .ready,
            usdPln: DayReportUsdPln(direction: .gain, move: "+0,08%", rate: fxRate),
            valueLine: DayReportValueLine(
                excludedSymbols: [],
                kind: .daily,
                partialDays: 0,
                points: points(lineValues.enumerated().map { (start + $0.offset * day, $0.element) }),
                windowLabel: "past week"
            )
        )
    }

    static var dayReportHistory: DayReportHistoryResponse {
        func item(_ day: String, _ label: String, _ amount: String, _ pct: String, gain: Bool, kind: DayReportPayloadKind) -> DayReportHistoryItem {
            DayReportHistoryItem(
                day: day,
                dayChange: DayReportHistoryItemDayReportSignedDisplay(
                    direction: gain ? .gain : .loss,
                    text: signed(amount, "zł", gain: gain)
                ),
                dayChangePct: pct,
                dayLabel: label,
                figureDay: day,
                figureDayLabel: label,
                kind: kind,
                narrativeStatus: .ready,
                partial: false
            )
        }
        return DayReportHistoryResponse(
            items: [
                item("2026-09-22", "Tue 22 Sep", "+252,34", "+0,36%", gain: true, kind: .close),
                item("2026-09-22", "Tue 22 Sep", "+180,00", "+0,26%", gain: true, kind: .morning),
                item("2026-09-19", "Fri 19 Sep", "-140,20", "-0,20%", gain: false, kind: .close),
            ],
            nextCursor: nil
        )
    }

    // MARK: - Widgets

    static func widgetPayload() -> WidgetSummaryResponse {
        WidgetSummaryResponse(
            dayLines: WidgetDayLines(
                holdings: [
                    WidgetDayPoint(p: "0", t: 0),
                    WidgetDayPoint(p: "-0.21", t: 5_400_000),
                    WidgetDayPoint(p: "0.18", t: 10_800_000),
                    WidgetDayPoint(p: "0.46", t: 16_200_000),
                    WidgetDayPoint(p: "0.36", t: 23_400_000),
                ],
                options: [
                    WidgetDayPoint(p: "0", t: 0),
                    WidgetDayPoint(p: "0.80", t: 5_400_000),
                    WidgetDayPoint(p: "2.40", t: 10_800_000),
                    WidgetDayPoint(p: "1.40", t: 16_200_000),
                    WidgetDayPoint(p: "1.95", t: 23_400_000),
                ],
                sessionCloseMs: 23_400_000,
                sessionOpenMs: 0
            ),
            holdings: holdingsSummary,
            market: LiveMarket(
                nextTransitionAtMs: nil,
                nextTransitionKind: nil,
                pollingResumesAtMs: resumesAtMs,
                serverNowMs: closeMs,
                status: .closed
            ),
            options: optionsSummary
        )
    }
}
