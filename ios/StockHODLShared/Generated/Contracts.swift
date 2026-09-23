//
// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: src/lib/api/contracts/ (zod).
// Regenerate:      pnpm contracts:gen
//
// CI runs the generator and fails on `git diff --exit-code` over this
// directory, so an edit here is reverted by the next green build.
//
// Money is a String on purpose. Converting one to Decimal happens only in
// Money.swift; a `Double` anywhere near a price is non-negotiable #1.
//
// One wart worth knowing: `open` is a Swift declaration modifier, so
// quicktype spells that case `marketStatusOpen`. The RAW VALUE is still
// "open" — the wire is unaffected, only the Swift identifier is ugly.
//

import Foundation

// MARK: - About
struct About: Codable, Sendable {
    let description: String?
    let employees: String?
    let marketCap: String?
    let website: String?
    let week52: Week52Range?

    enum CodingKeys: String, CodingKey {
        case description = "description"
        case employees = "employees"
        case marketCap = "marketCap"
        case website = "website"
        case week52 = "week52"
    }
}

// MARK: - Week52Range
struct Week52Range: Codable, Sendable {
    let currentRaw: String?
    let high: String
    let highRaw: String
    let low: String
    let lowRaw: String

    enum CodingKeys: String, CodingKey {
        case currentRaw = "currentRaw"
        case high = "high"
        case highRaw = "highRaw"
        case low = "low"
        case lowRaw = "lowRaw"
    }
}

// MARK: - AllocationSlice
struct AllocationSlice: Codable, Sendable {
    let colorVar: String
    let key: String
    let label: String
    let pct: String
    let share: String
    let value: String

    enum CodingKeys: String, CodingKey {
        case colorVar = "colorVar"
        case key = "key"
        case label = "label"
        case pct = "pct"
        case share = "share"
        case value = "value"
    }
}

// MARK: - AnalyticsBenchmark
struct AnalyticsBenchmark: Codable, Sendable {
    let benchmark: [ChartPoint]
    let degradedReason: BenchmarkRefusal?
    let portfolio: [ChartPoint]

    enum CodingKeys: String, CodingKey {
        case benchmark = "benchmark"
        case degradedReason = "degradedReason"
        case portfolio = "portfolio"
    }
}

// MARK: - ChartPoint
struct ChartPoint: Codable, Sendable {
    let h: String?
    let l: String?
    let o: String?
    let p: SessionMarker?
    let r: String?
    let t: Int
    let v: String

    enum CodingKeys: String, CodingKey {
        case h = "h"
        case l = "l"
        case o = "o"
        case p = "p"
        case r = "r"
        case t = "t"
        case v = "v"
    }
}

enum SessionMarker: String, Codable, Sendable {
    case post = "post"
    case pre = "pre"
}

enum BenchmarkRefusal: String, Codable, Sendable {
    case noBaseline = "no_baseline"
    case noBenchmarkHistory = "no_benchmark_history"
}

// MARK: - AnalyticsBreakdown
struct AnalyticsBreakdown: Codable, Sendable {
    let currency: [AllocationSlice]
    let portfolio: [AllocationSlice]
    let sector: [AllocationSlice]
    let ticker: [AllocationSlice]

    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case portfolio = "portfolio"
        case sector = "sector"
        case ticker = "ticker"
    }
}

// MARK: - AnalyticsConcentration
struct AnalyticsConcentration: Codable, Sendable {
    let score: String
    let topShare: String
    let topSymbol: String

    enum CodingKeys: String, CodingKey {
        case score = "score"
        case topShare = "topShare"
        case topSymbol = "topSymbol"
    }
}

// MARK: - AnalyticsMetric
struct AnalyticsMetric: Codable, Sendable {
    let direction: Direction
    let note: String?
    let value: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case note = "note"
        case value = "value"
    }
}

enum Direction: String, Codable, Sendable {
    case gain = "gain"
    case loss = "loss"
    case neutral = "neutral"
}

// MARK: - AnalyticsResponse
struct AnalyticsResponse: Codable, Sendable {
    let benchmark: AnalyticsBenchmark
    let breakdown: AnalyticsBreakdown
    let concentration: AnalyticsConcentration?
    let excludedSymbols: [ExcludedSymbol]
    let inceptionDateISO: String?
    let partialDays: Int
    let scopeId: String?
    let scopes: [AnalyticsScope]
    let skippedDays: Int
    let targetDrift: AnalyticsTargetDrift?
    let totalGain: String?
    let totalGainDirection: Direction
    let totalValue: String?
    let twrrAnnualized: AnalyticsMetric
    let twrrCumulative: AnalyticsMetric
    let xirr: AnalyticsMetric

    enum CodingKeys: String, CodingKey {
        case benchmark = "benchmark"
        case breakdown = "breakdown"
        case concentration = "concentration"
        case excludedSymbols = "excludedSymbols"
        case inceptionDateISO = "inceptionDateISO"
        case partialDays = "partialDays"
        case scopeId = "scopeId"
        case scopes = "scopes"
        case skippedDays = "skippedDays"
        case targetDrift = "targetDrift"
        case totalGain = "totalGain"
        case totalGainDirection = "totalGainDirection"
        case totalValue = "totalValue"
        case twrrAnnualized = "twrrAnnualized"
        case twrrCumulative = "twrrCumulative"
        case xirr = "xirr"
    }
}

// MARK: - ExcludedSymbol
struct ExcludedSymbol: Codable, Sendable {
    let reason: ExclusionReason
    let symbol: String

    enum CodingKeys: String, CodingKey {
        case reason = "reason"
        case symbol = "symbol"
    }
}

enum ExclusionReason: String, Codable, Sendable {
    case noLiveQuote = "no_live_quote"
    case noPriceHistory = "no_price_history"
}

// MARK: - AnalyticsScope
struct AnalyticsScope: Codable, Sendable {
    let id: String
    let name: String

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
    }
}

// MARK: - AnalyticsTargetDrift
struct AnalyticsTargetDrift: Codable, Sendable {
    let rows: [AnalyticsTargetDriftRow]
    let sumNote: String?

    enum CodingKeys: String, CodingKey {
        case rows = "rows"
        case sumNote = "sumNote"
    }
}

// MARK: - AnalyticsTargetDriftRow
struct AnalyticsTargetDriftRow: Codable, Sendable {
    let action: TransactionSide?
    let actual: String
    let amount: String?
    let drift: String?
    let instrumentId: String
    let symbol: String
    let target: String?

    enum CodingKeys: String, CodingKey {
        case action = "action"
        case actual = "actual"
        case amount = "amount"
        case drift = "drift"
        case instrumentId = "instrumentId"
        case symbol = "symbol"
        case target = "target"
    }
}

enum TransactionSide: String, Codable, Sendable {
    case buy = "buy"
    case sell = "sell"
}

// MARK: - BootstrapResponse
struct BootstrapResponse: Codable, Sendable {
    let live: LivePayload
    let portfolios: [Portfolio]
    let scopes: [StaticScope]
    let staticHoldings: [StaticHolding]
    let watchlist: [WatchedItem]

    enum CodingKeys: String, CodingKey {
        case live = "live"
        case portfolios = "portfolios"
        case scopes = "scopes"
        case staticHoldings = "staticHoldings"
        case watchlist = "watchlist"
    }
}

// MARK: - LivePayload
struct LivePayload: Codable, Sendable {
    let hasPollableSymbols: Bool
    let holdings: [LiveHolding]
    let market: LiveMarket
    let scopes: [LiveScope]
    let summary: LiveSummary

    enum CodingKeys: String, CodingKey {
        case hasPollableSymbols = "hasPollableSymbols"
        case holdings = "holdings"
        case market = "market"
        case scopes = "scopes"
        case summary = "summary"
    }
}

// MARK: - LiveHolding
struct LiveHolding: Codable, Sendable {
    let cachedPrice: CachedPrice?
    let dayPct: LiveFigure?
    let direction: Direction
    let extended: ExtendedFigure?
    let instrumentId: String
    let price: String?
    let unrealizedPct: String
    let unrealizedPLN: String?
    let unrealizedPLNRaw: String?
    let valuePLN: String?
    let valuePLNRaw: String?

    enum CodingKeys: String, CodingKey {
        case cachedPrice = "cachedPrice"
        case dayPct = "dayPct"
        case direction = "direction"
        case extended = "extended"
        case instrumentId = "instrumentId"
        case price = "price"
        case unrealizedPct = "unrealizedPct"
        case unrealizedPLN = "unrealizedPLN"
        case unrealizedPLNRaw = "unrealizedPLNRaw"
        case valuePLN = "valuePLN"
        case valuePLNRaw = "valuePLNRaw"
    }
}

// MARK: - CachedPrice
struct CachedPrice: Codable, Sendable {
    let asOfMs: Int
    let text: String

    enum CodingKeys: String, CodingKey {
        case asOfMs = "asOfMs"
        case text = "text"
    }
}

// MARK: - LiveFigure
struct LiveFigure: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

// MARK: - ExtendedFigure
struct ExtendedFigure: Codable, Sendable {
    let direction: Direction
    let endedAtMs: Int?
    let kind: ExtendedSessionKind
    let live: Bool
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case endedAtMs = "endedAtMs"
        case kind = "kind"
        case live = "live"
        case text = "text"
    }
}

enum ExtendedSessionKind: String, Codable, Sendable {
    case early = "early"
    case late = "late"
}

// MARK: - LiveMarket
struct LiveMarket: Codable, Sendable {
    let nextTransitionAtMs: Int?
    let nextTransitionKind: MarketTransitionKind?
    let pollingResumesAtMs: Int?
    let serverNowMs: Int
    let status: MarketStatus

    enum CodingKeys: String, CodingKey {
        case nextTransitionAtMs = "nextTransitionAtMs"
        case nextTransitionKind = "nextTransitionKind"
        case pollingResumesAtMs = "pollingResumesAtMs"
        case serverNowMs = "serverNowMs"
        case status = "status"
    }
}

enum MarketTransitionKind: String, Codable, Sendable {
    case close = "close"
    case marketTransitionKindOpen = "open"
}

enum MarketStatus: String, Codable, Sendable {
    case closed = "closed"
    case earlyTrading = "early_trading"
    case lateTrading = "late_trading"
    case marketStatusOpen = "open"
    case unknown = "unknown"
}

// MARK: - LiveScope
struct LiveScope: Codable, Sendable {
    let holdings: [LiveHolding]
    let id: String
    let summary: LiveSummary

    enum CodingKeys: String, CodingKey {
        case holdings = "holdings"
        case id = "id"
        case summary = "summary"
    }
}

// MARK: - LiveSummary
struct LiveSummary: Codable, Sendable {
    let dayChange: LiveFigure?
    let dayChangePct: String?
    let excludedSymbols: [String]
    let partialDayChange: Bool
    let totalChange: LiveFigure?
    let totalChangePct: String?
    let totalValue: String?
    let trend: [TrendDay?]?

    enum CodingKeys: String, CodingKey {
        case dayChange = "dayChange"
        case dayChangePct = "dayChangePct"
        case excludedSymbols = "excludedSymbols"
        case partialDayChange = "partialDayChange"
        case totalChange = "totalChange"
        case totalChangePct = "totalChangePct"
        case totalValue = "totalValue"
        case trend = "trend"
    }
}

// MARK: - TrendDay
struct TrendDay: Codable, Sendable {
    let date: String
    let direction: Direction
    let level: Int
    let pct: String

    enum CodingKeys: String, CodingKey {
        case date = "date"
        case direction = "direction"
        case level = "level"
        case pct = "pct"
    }
}

// MARK: - Portfolio
struct Portfolio: Codable, Sendable {
    let id: String
    let name: String
    let sortOrder: Int
    let txCount: Int

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case sortOrder = "sortOrder"
        case txCount = "txCount"
    }
}

// MARK: - StaticScope
struct StaticScope: Codable, Sendable {
    let id: String
    let name: String
    let staticHoldings: [StaticHolding]
    let txCount: Int

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case staticHoldings = "staticHoldings"
        case txCount = "txCount"
    }
}

// MARK: - StaticHolding
struct StaticHolding: Codable, Sendable {
    let avgCost: String?
    let costBasisPLN: String
    let currency: Currency
    let displayName: String
    let instrumentId: String
    let oversold: Bool
    let quantity: String
    let symbol: String
    let trend: [TrendDay?]?

    enum CodingKeys: String, CodingKey {
        case avgCost = "avgCost"
        case costBasisPLN = "costBasisPLN"
        case currency = "currency"
        case displayName = "displayName"
        case instrumentId = "instrumentId"
        case oversold = "oversold"
        case quantity = "quantity"
        case symbol = "symbol"
        case trend = "trend"
    }
}

enum Currency: String, Codable, Sendable {
    case chf = "CHF"
    case eur = "EUR"
    case gbp = "GBP"
    case pln = "PLN"
    case usd = "USD"
}

// MARK: - WatchedItem
struct WatchedItem: Codable, Sendable {
    let currency: Currency
    let displayName: String
    let instrumentId: String
    let symbol: String
    let trend: [TrendDay?]?

    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case displayName = "displayName"
        case instrumentId = "instrumentId"
        case symbol = "symbol"
        case trend = "trend"
    }
}

// MARK: - CurrencyTile
struct CurrencyTile: Codable, Sendable {
    let caption: String
    let dayPct: LiveFigure?
    let key: MarketTileKey
    let last: String?
    let pairLabel: String
    let spark: [ChartPoint]
    let trend: [TrendDay?]?

    enum CodingKeys: String, CodingKey {
        case caption = "caption"
        case dayPct = "dayPct"
        case key = "key"
        case last = "last"
        case pairLabel = "pairLabel"
        case spark = "spark"
        case trend = "trend"
    }
}

enum MarketTileKey: String, Codable, Sendable {
    case dia = "DIA"
    case qqq = "QQQ"
    case spy = "SPY"
    case usdpln = "USDPLN"
}

// MARK: - DayReportHistoryItem
struct DayReportHistoryItem: Codable, Sendable {
    let day: String
    let dayChange: DayReportHistoryItemDayReportSignedDisplay?
    let dayChangePct: String?
    let dayLabel: String
    let figureDay: String?
    let figureDayLabel: String?
    let kind: DayReportPayloadKind
    let narrativeStatus: DayReportHistoryNarrativeStatus
    let partial: Bool

    enum CodingKeys: String, CodingKey {
        case day = "day"
        case dayChange = "dayChange"
        case dayChangePct = "dayChangePct"
        case dayLabel = "dayLabel"
        case figureDay = "figureDay"
        case figureDayLabel = "figureDayLabel"
        case kind = "kind"
        case narrativeStatus = "narrativeStatus"
        case partial = "partial"
    }
}

// MARK: - DayReportHistoryItemDayReportSignedDisplay
struct DayReportHistoryItemDayReportSignedDisplay: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

enum DayReportPayloadKind: String, Codable, Sendable {
    case close = "close"
    case morning = "morning"
}

enum DayReportHistoryNarrativeStatus: String, Codable, Sendable {
    case ready = "ready"
    case refused = "refused"
}

// MARK: - DayReportHistoryQuery
struct DayReportHistoryQuery: Codable, Sendable {
    let cursor: String?

    enum CodingKeys: String, CodingKey {
        case cursor = "cursor"
    }
}

// MARK: - DayReportHistoryResponse
struct DayReportHistoryResponse: Codable, Sendable {
    let items: [DayReportHistoryItem]
    let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case items = "items"
        case nextCursor = "nextCursor"
    }
}

// MARK: - DayReportNarrative
struct DayReportNarrative: Codable, Sendable {
    let events: [DayReportNarrativeEvent]
    let eventsNarrative: String?
    let macroNarrative: String?
    let portfolioNarrative: String?
    let sources: [DayReportSource]
    let staleFigures: Bool
    let status: DayReportNarrativeStatus
    let todayLine: String?

    enum CodingKeys: String, CodingKey {
        case events = "events"
        case eventsNarrative = "eventsNarrative"
        case macroNarrative = "macroNarrative"
        case portfolioNarrative = "portfolioNarrative"
        case sources = "sources"
        case staleFigures = "staleFigures"
        case status = "status"
        case todayLine = "todayLine"
    }
}

// MARK: - DayReportNarrativeEvent
struct DayReportNarrativeEvent: Codable, Sendable {
    let date: String
    let symbol: String?
    let title: String

    enum CodingKeys: String, CodingKey {
        case date = "date"
        case symbol = "symbol"
        case title = "title"
    }
}

// MARK: - DayReportSource
struct DayReportSource: Codable, Sendable {
    let title: String
    let url: String

    enum CodingKeys: String, CodingKey {
        case title = "title"
        case url = "url"
    }
}

enum DayReportNarrativeStatus: String, Codable, Sendable {
    case notConfigured = "not_configured"
    case pending = "pending"
    case ready = "ready"
    case refused = "refused"
    case unavailable = "unavailable"
}

// MARK: - DayReportNarrativeRequest
struct DayReportNarrativeRequest: Codable, Sendable {
    let day: String
    let kind: DayReportPayloadKind
    let p: String?

    enum CodingKeys: String, CodingKey {
        case day = "day"
        case kind = "kind"
        case p = "p"
    }
}

// MARK: - DayReportNarrativeResponse
struct DayReportNarrativeResponse: Codable, Sendable {
    let narrative: DayReportNarrative

    enum CodingKeys: String, CodingKey {
        case narrative = "narrative"
    }
}

// MARK: - DayReportQuery
struct DayReportQuery: Codable, Sendable {
    let day: String?
    let kind: DayReportPayloadKind?
    let p: String?

    enum CodingKeys: String, CodingKey {
        case day = "day"
        case kind = "kind"
        case p = "p"
    }
}

// MARK: - DayReportResponse
struct DayReportResponse: Codable, Sendable {
    let benchmarks: [DayReportBenchmark]
    let day: String
    let dayLabel: String
    let events: DayReportEvents
    let figures: DayReportFigures
    let headlines: [DayReportHeadline]
    let isLatest: Bool
    let kind: DayReportPayloadKind
    let movers: [MoverElement]
    let narrative: DayReportNarrative
    let nearestDay: String?
    let nextDay: String?
    let optionMovers: [OptionMoverElement]
    let prevDay: String?
    let recap: DayReportRecap?
    let scopeId: String?
    let scopes: [AnalyticsScope]
    let segments: DayReportSegments
    let status: DayReportResponseStatus
    let usdPln: DayReportUsdPln?
    let valueLine: DayReportValueLine

    enum CodingKeys: String, CodingKey {
        case benchmarks = "benchmarks"
        case day = "day"
        case dayLabel = "dayLabel"
        case events = "events"
        case figures = "figures"
        case headlines = "headlines"
        case isLatest = "isLatest"
        case kind = "kind"
        case movers = "movers"
        case narrative = "narrative"
        case nearestDay = "nearestDay"
        case nextDay = "nextDay"
        case optionMovers = "optionMovers"
        case prevDay = "prevDay"
        case recap = "recap"
        case scopeId = "scopeId"
        case scopes = "scopes"
        case segments = "segments"
        case status = "status"
        case usdPln = "usdPln"
        case valueLine = "valueLine"
    }
}

// MARK: - DayReportBenchmark
struct DayReportBenchmark: Codable, Sendable {
    let dayPct: String?
    let direction: Direction
    let extendedKind: ExtendedSessionKind?
    let extendedPct: String?
    let indexName: String
    let proxySymbol: String

    enum CodingKeys: String, CodingKey {
        case dayPct = "dayPct"
        case direction = "direction"
        case extendedKind = "extendedKind"
        case extendedPct = "extendedPct"
        case indexName = "indexName"
        case proxySymbol = "proxySymbol"
    }
}

// MARK: - DayReportEvents
struct DayReportEvents: Codable, Sendable {
    let earningsCaption: String
    let items: [DayReportEvent]

    enum CodingKeys: String, CodingKey {
        case earningsCaption = "earningsCaption"
        case items = "items"
    }
}

// MARK: - DayReportEvent
struct DayReportEvent: Codable, Sendable {
    let date: String
    let detail: String
    let kind: DayReportEventKind
    let symbol: String

    enum CodingKeys: String, CodingKey {
        case date = "date"
        case detail = "detail"
        case kind = "kind"
        case symbol = "symbol"
    }
}

enum DayReportEventKind: String, Codable, Sendable {
    case exDividend = "ex_dividend"
    case optionExpiry = "option_expiry"
}

// MARK: - DayReportFigures
struct DayReportFigures: Codable, Sendable {
    let dayChange: FiguresDayReportSignedDisplay?
    let dayChangePct: String?
    let excludedSymbols: [String]
    let holdings: PurpleDayReportFigurePart?
    let options: FluffyDayReportFigurePart?
    let optionsDayChangeUSD: String?
    let optionsNote: String?
    let optionsRelation: OptionsRelation?
    let partial: Bool
    let partialSymbols: [String]
    let positionCount: Int
    let source: FiguresSource?
    let status: FiguresStatus
    let valueAtClose: String?

    enum CodingKeys: String, CodingKey {
        case dayChange = "dayChange"
        case dayChangePct = "dayChangePct"
        case excludedSymbols = "excludedSymbols"
        case holdings = "holdings"
        case options = "options"
        case optionsDayChangeUSD = "optionsDayChangeUSD"
        case optionsNote = "optionsNote"
        case optionsRelation = "optionsRelation"
        case partial = "partial"
        case partialSymbols = "partialSymbols"
        case positionCount = "positionCount"
        case source = "source"
        case status = "status"
        case valueAtClose = "valueAtClose"
    }
}

// MARK: - FiguresDayReportSignedDisplay
struct FiguresDayReportSignedDisplay: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

// MARK: - PurpleDayReportFigurePart
struct PurpleDayReportFigurePart: Codable, Sendable {
    let dayChange: PurpleDayReportSignedDisplay?
    let dayChangePct: String?
    let valueAtClose: String?

    enum CodingKeys: String, CodingKey {
        case dayChange = "dayChange"
        case dayChangePct = "dayChangePct"
        case valueAtClose = "valueAtClose"
    }
}

// MARK: - PurpleDayReportSignedDisplay
struct PurpleDayReportSignedDisplay: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

// MARK: - FluffyDayReportFigurePart
struct FluffyDayReportFigurePart: Codable, Sendable {
    let dayChange: FluffyDayReportSignedDisplay?
    let dayChangePct: String?
    let valueAtClose: String?

    enum CodingKeys: String, CodingKey {
        case dayChange = "dayChange"
        case dayChangePct = "dayChangePct"
        case valueAtClose = "valueAtClose"
    }
}

// MARK: - FluffyDayReportSignedDisplay
struct FluffyDayReportSignedDisplay: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

enum OptionsRelation: String, Codable, Sendable {
    case amplified = "amplified"
    case cushioned = "cushioned"
    case flat = "flat"
}

enum FiguresSource: String, Codable, Sendable {
    case live = "live"
    case stored = "stored"
}

enum FiguresStatus: String, Codable, Sendable {
    case empty = "empty"
    case notReady = "not_ready"
    case ready = "ready"
}

// MARK: - DayReportHeadline
struct DayReportHeadline: Codable, Sendable {
    let id: String
    let matchedTickers: [String]
    let publishedAtMs: Int
    let publisherName: String?
    let sentiment: String?
    let summary: String?
    let title: String
    let url: String

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case matchedTickers = "matchedTickers"
        case publishedAtMs = "publishedAtMs"
        case publisherName = "publisherName"
        case sentiment = "sentiment"
        case summary = "summary"
        case title = "title"
        case url = "url"
    }
}

// MARK: - MoverElement
struct MoverElement: Codable, Sendable {
    let barShare: String
    let contribution: MoverContribution
    let displayName: String
    let pricePct: String?
    let symbol: String

    enum CodingKeys: String, CodingKey {
        case barShare = "barShare"
        case contribution = "contribution"
        case displayName = "displayName"
        case pricePct = "pricePct"
        case symbol = "symbol"
    }
}

// MARK: - MoverContribution
struct MoverContribution: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

// MARK: - OptionMoverElement
struct OptionMoverElement: Codable, Sendable {
    let barShare: String
    let contribution: OptionMoverContribution
    let displayName: String
    let pricePct: String?
    let symbol: String

    enum CodingKeys: String, CodingKey {
        case barShare = "barShare"
        case contribution = "contribution"
        case displayName = "displayName"
        case pricePct = "pricePct"
        case symbol = "symbol"
    }
}

// MARK: - OptionMoverContribution
struct OptionMoverContribution: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

// MARK: - DayReportRecap
struct DayReportRecap: Codable, Sendable {
    let day: String
    let dayChange: DayChangeClass
    let dayChangePct: String?

    enum CodingKeys: String, CodingKey {
        case day = "day"
        case dayChange = "dayChange"
        case dayChangePct = "dayChangePct"
    }
}

// MARK: - DayChangeClass
struct DayChangeClass: Codable, Sendable {
    let direction: Direction
    let text: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case text = "text"
    }
}

// MARK: - DayReportSegments
struct DayReportSegments: Codable, Sendable {
    let close: Close
    let morning: Morning

    enum CodingKeys: String, CodingKey {
        case close = "close"
        case morning = "morning"
    }
}

enum Close: String, Codable, Sendable {
    case marketOpen = "market_open"
    case notReady = "not_ready"
    case ready = "ready"
}

enum Morning: String, Codable, Sendable {
    case none = "none"
    case ready = "ready"
}

enum DayReportResponseStatus: String, Codable, Sendable {
    case ready = "ready"
    case unavailable = "unavailable"
}

// MARK: - DayReportUsdPln
struct DayReportUsdPln: Codable, Sendable {
    let direction: Direction
    let move: String
    let rate: String

    enum CodingKeys: String, CodingKey {
        case direction = "direction"
        case move = "move"
        case rate = "rate"
    }
}

// MARK: - DayReportValueLine
struct DayReportValueLine: Codable, Sendable {
    let excludedSymbols: [String]
    let kind: DayReportValueLineKind
    let partialDays: Int
    let points: [ChartPoint]
    let windowLabel: String?

    enum CodingKeys: String, CodingKey {
        case excludedSymbols = "excludedSymbols"
        case kind = "kind"
        case partialDays = "partialDays"
        case points = "points"
        case windowLabel = "windowLabel"
    }
}

enum DayReportValueLineKind: String, Codable, Sendable {
    case daily = "daily"
    case intraday = "intraday"
    case none = "none"
}

// MARK: - DayStats
struct DayStats: Codable, Sendable {
    let dayHigh: String?
    let dayLow: String?
    let dayOpen: String?
    let prevClose: String?
    let volume: String?
    let vwap: String?

    enum CodingKeys: String, CodingKey {
        case dayHigh = "dayHigh"
        case dayLow = "dayLow"
        case dayOpen = "dayOpen"
        case prevClose = "prevClose"
        case volume = "volume"
        case vwap = "vwap"
    }
}

// MARK: - DividendInstrument
struct DividendInstrument: Codable, Sendable {
    let currency: String
    let displayName: String
    let id: String
    let symbol: String

    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case displayName = "displayName"
        case id = "id"
        case symbol = "symbol"
    }
}

// MARK: - DividendInstrumentList
struct DividendInstrumentList: Codable, Sendable {
    let instruments: [DividendInstrument]
    let portfolios: [DividendInstrumentListPortfolio]

    enum CodingKeys: String, CodingKey {
        case instruments = "instruments"
        case portfolios = "portfolios"
    }
}

// MARK: - DividendInstrumentListPortfolio
struct DividendInstrumentListPortfolio: Codable, Sendable {
    let id: String
    let name: String

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
    }
}

// MARK: - DividendPayment
struct DividendPayment: Codable, Sendable {
    let amountPerShare: String
    let currency: String
    let displayName: String
    let edited: Bool
    let exDate: String
    let fxRateToBase: String?
    let grossAmount: String
    let id: String
    let instrumentId: String
    let netAmount: String
    let note: String?
    let payDate: String?
    let portfolioId: String
    let portfolioName: String
    let quantity: String
    let source: DividendPaymentSource
    let symbol: String
    let withheldTax: String

    enum CodingKeys: String, CodingKey {
        case amountPerShare = "amountPerShare"
        case currency = "currency"
        case displayName = "displayName"
        case edited = "edited"
        case exDate = "exDate"
        case fxRateToBase = "fxRateToBase"
        case grossAmount = "grossAmount"
        case id = "id"
        case instrumentId = "instrumentId"
        case netAmount = "netAmount"
        case note = "note"
        case payDate = "payDate"
        case portfolioId = "portfolioId"
        case portfolioName = "portfolioName"
        case quantity = "quantity"
        case source = "source"
        case symbol = "symbol"
        case withheldTax = "withheldTax"
    }
}

enum DividendPaymentSource: String, Codable, Sendable {
    case manual = "manual"
    case massive = "massive"
}

// MARK: - DividendSummary
struct DividendSummary: Codable, Sendable {
    let awaitingFx: Int
    let count: Int
    let fxUnsupported: Int
    let netPLN: String?
    let ytdNetPLN: String?

    enum CodingKeys: String, CodingKey {
        case awaitingFx = "awaitingFx"
        case count = "count"
        case fxUnsupported = "fxUnsupported"
        case netPLN = "netPLN"
        case ytdNetPLN = "ytdNetPLN"
    }
}

// MARK: - DividendYearGroup
struct DividendYearGroup: Codable, Sendable {
    let awaitingFx: Int
    let fxUnsupported: Int
    let netPLN: String?
    let paymentIds: [String]
    let totals: [DividendYearTotal]
    let year: String

    enum CodingKeys: String, CodingKey {
        case awaitingFx = "awaitingFx"
        case fxUnsupported = "fxUnsupported"
        case netPLN = "netPLN"
        case paymentIds = "paymentIds"
        case totals = "totals"
        case year = "year"
    }
}

// MARK: - DividendYearTotal
struct DividendYearTotal: Codable, Sendable {
    let currency: String
    let gross: String
    let net: String
    let withheld: String

    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case gross = "gross"
        case net = "net"
        case withheld = "withheld"
    }
}

// MARK: - DividendsResponse
struct DividendsResponse: Codable, Sendable {
    let payments: [DividendPayment]
    let summary: DividendSummary
    let years: [DividendYearGroup]

    enum CodingKeys: String, CodingKey {
        case payments = "payments"
        case summary = "summary"
        case years = "years"
    }
}

// MARK: - ErrorResponse
struct ErrorResponse: Codable, Sendable {
    let error: String

    enum CodingKeys: String, CodingKey {
        case error = "error"
    }
}

// MARK: - FxRateResponse
struct FxRateResponse: Codable, Sendable {
    let ok: Bool
    let rate: String?
    let rateDate: String?
    let reason: FxRateFailureReason?

    enum CodingKeys: String, CodingKey {
        case ok = "ok"
        case rate = "rate"
        case rateDate = "rateDate"
        case reason = "reason"
    }
}

enum FxRateFailureReason: String, Codable, Sendable {
    case invalid = "invalid"
    case noRate = "no_rate"
    case notPublished = "not_published"
    case unavailable = "unavailable"
}

// MARK: - IndexTile
struct IndexTile: Codable, Sendable {
    let dayPct: LiveFigure?
    let indexName: String
    let key: MarketTileKey
    let last: String?
    let proxySymbol: String
    let spark: [ChartPoint]
    let trend: [TrendDay?]?

    enum CodingKeys: String, CodingKey {
        case dayPct = "dayPct"
        case indexName = "indexName"
        case key = "key"
        case last = "last"
        case proxySymbol = "proxySymbol"
        case spark = "spark"
        case trend = "trend"
    }
}

// MARK: - InstrumentResponse
struct InstrumentResponse: Codable, Sendable {
    let about: About
    let cachedPrice: CachedPrice?
    let currency: Currency
    let dayPct: LiveFigure?
    let dayStats: DayStats
    let displayName: String
    let exchange: String
    let extended: ExtendedFigure?
    let groups: [PortfolioGroup]
    let hasDividends: Bool
    let instrumentId: String
    let owned: Bool
    let position: PositionFigures?
    let price: String?
    let priceTargets: [PriceTarget]
    let symbol: String
    let targetStatus: TargetStatus?
    let transactions: [TransactionRow]
    let watched: Bool

    enum CodingKeys: String, CodingKey {
        case about = "about"
        case cachedPrice = "cachedPrice"
        case currency = "currency"
        case dayPct = "dayPct"
        case dayStats = "dayStats"
        case displayName = "displayName"
        case exchange = "exchange"
        case extended = "extended"
        case groups = "groups"
        case hasDividends = "hasDividends"
        case instrumentId = "instrumentId"
        case owned = "owned"
        case position = "position"
        case price = "price"
        case priceTargets = "priceTargets"
        case symbol = "symbol"
        case targetStatus = "targetStatus"
        case transactions = "transactions"
        case watched = "watched"
    }
}

// MARK: - PortfolioGroup
struct PortfolioGroup: Codable, Sendable {
    let portfolioId: String
    let portfolioName: String
    let summary: PositionFigures

    enum CodingKeys: String, CodingKey {
        case portfolioId = "portfolioId"
        case portfolioName = "portfolioName"
        case summary = "summary"
    }
}

// MARK: - PositionFigures
struct PositionFigures: Codable, Sendable {
    let avgCost: String?
    let costBasisPLN: String
    let currency: Currency
    let direction: Direction
    let oversold: Bool
    let quantity: String
    let unrealizedPct: String
    let unrealizedPLN: String?
    let valuePLN: String?

    enum CodingKeys: String, CodingKey {
        case avgCost = "avgCost"
        case costBasisPLN = "costBasisPLN"
        case currency = "currency"
        case direction = "direction"
        case oversold = "oversold"
        case quantity = "quantity"
        case unrealizedPct = "unrealizedPct"
        case unrealizedPLN = "unrealizedPLN"
        case valuePLN = "valuePLN"
    }
}

// MARK: - PriceTarget
struct PriceTarget: Codable, Sendable {
    let createdAtMs: Int
    let direction: TargetDirection
    let hitAtMs: Int?
    let id: String
    let instrumentId: String
    let targetPrice: String

    enum CodingKeys: String, CodingKey {
        case createdAtMs = "createdAtMs"
        case direction = "direction"
        case hitAtMs = "hitAtMs"
        case id = "id"
        case instrumentId = "instrumentId"
        case targetPrice = "targetPrice"
    }
}

enum TargetDirection: String, Codable, Sendable {
    case down = "down"
    case up = "up"
}

// MARK: - TargetStatus
struct TargetStatus: Codable, Sendable {
    let hitOnly: Bool
    let near: Bool
    let sentence: String
    let side: TargetSide?
    let text: String

    enum CodingKeys: String, CodingKey {
        case hitOnly = "hitOnly"
        case near = "near"
        case sentence = "sentence"
        case side = "side"
        case text = "text"
    }
}

enum TargetSide: String, Codable, Sendable {
    case above = "above"
    case below = "below"
}

// MARK: - TransactionRow
struct TransactionRow: Codable, Sendable {
    let currency: Currency
    let displayName: String
    let exchange: String
    let fees: String
    let fxRateToBase: String
    let id: String
    let instrumentId: String
    let note: String?
    let portfolioId: String
    let portfolioName: String
    let price: String
    let quantity: String
    let side: TransactionSide
    let symbol: String
    let tradeDate: String

    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case displayName = "displayName"
        case exchange = "exchange"
        case fees = "fees"
        case fxRateToBase = "fxRateToBase"
        case id = "id"
        case instrumentId = "instrumentId"
        case note = "note"
        case portfolioId = "portfolioId"
        case portfolioName = "portfolioName"
        case price = "price"
        case quantity = "quantity"
        case side = "side"
        case symbol = "symbol"
        case tradeDate = "tradeDate"
    }
}

// MARK: - LiveWatchItem
struct LiveWatchItem: Codable, Sendable {
    let dayPct: LiveFigure?
    let extended: ExtendedFigure?
    let instrumentId: String
    let price: String?
    let target: TargetStatus?
    let targetGroup: TargetGroup

    enum CodingKeys: String, CodingKey {
        case dayPct = "dayPct"
        case extended = "extended"
        case instrumentId = "instrumentId"
        case price = "price"
        case target = "target"
        case targetGroup = "targetGroup"
    }
}

enum TargetGroup: String, Codable, Sendable {
    case near = "near"
    case none = "none"
    case targetGroupSet = "set"
}

enum MarketDataHealth: String, Codable, Sendable {
    case ok = "ok"
    case unauthorized = "unauthorized"
    case unreachable = "unreachable"
}

// MARK: - MarketStripPayload
struct MarketStripPayload: Codable, Sendable {
    let fx: CurrencyTile
    let market: LiveMarket
    let tiles: [IndexTile]

    enum CodingKeys: String, CodingKey {
        case fx = "fx"
        case market = "market"
        case tiles = "tiles"
    }
}

// MARK: - NewsArticleResponse
struct NewsArticleResponse: Codable, Sendable {
    let articleUrl: String
    let author: String?
    let description: String?
    let hasImage: Bool
    let id: String
    let insights: [Insight]
    let keywords: [String]
    let linkableTickers: [String]
    let publishedAtMs: Int
    let publisherHomepage: String?
    let publisherName: String?
    let tickers: [String]
    let title: String

    enum CodingKeys: String, CodingKey {
        case articleUrl = "articleUrl"
        case author = "author"
        case description = "description"
        case hasImage = "hasImage"
        case id = "id"
        case insights = "insights"
        case keywords = "keywords"
        case linkableTickers = "linkableTickers"
        case publishedAtMs = "publishedAtMs"
        case publisherHomepage = "publisherHomepage"
        case publisherName = "publisherName"
        case tickers = "tickers"
        case title = "title"
    }
}

// MARK: - Insight
struct Insight: Codable, Sendable {
    let sentiment: String?
    let ticker: String

    enum CodingKeys: String, CodingKey {
        case sentiment = "sentiment"
        case ticker = "ticker"
    }
}

// MARK: - NewsFeedResponse
struct NewsFeedResponse: Codable, Sendable {
    let articles: [NewsItem]
    let degraded: Bool
    let omitted: [String]

    enum CodingKeys: String, CodingKey {
        case articles = "articles"
        case degraded = "degraded"
        case omitted = "omitted"
    }
}

// MARK: - NewsItem
struct NewsItem: Codable, Sendable {
    let hasImage: Bool
    let hasPublisherLogo: Bool
    let id: String
    let matchedTickers: [String]
    let publishedAtMs: Int
    let publisherName: String?
    let title: String

    enum CodingKeys: String, CodingKey {
        case hasImage = "hasImage"
        case hasPublisherLogo = "hasPublisherLogo"
        case id = "id"
        case matchedTickers = "matchedTickers"
        case publishedAtMs = "publishedAtMs"
        case publisherName = "publisherName"
        case title = "title"
    }
}

// MARK: - NotificationPreferences
struct NotificationPreferences: Codable, Sendable {
    let dailySummary: Bool
    let priceAlerts: Bool

    enum CodingKeys: String, CodingKey {
        case dailySummary = "dailySummary"
        case priceAlerts = "priceAlerts"
    }
}

// MARK: - OkResponse
struct OkResponse: Codable, Sendable {
    let ok: Bool

    enum CodingKeys: String, CodingKey {
        case ok = "ok"
    }
}

// MARK: - OptionCardItem
struct OptionCardItem: Codable, Sendable {
    let breakEven: String
    let contractType: ContractType
    let day: LiveFigure?
    let dayBasisLabel: String?
    let dayPct: LiveFigure?
    let daysToExpiry: Int
    let delta: String
    let entryIsAverage: Bool
    let entryPrice: String
    let expirationDate: String
    let expired: Bool
    let expiryLabel: String
    let fees: String?
    let gamma: String
    let hasQuote: Bool
    let impliedVolatility: String
    let key: String
    let lastTradeBeyondLookback: Bool
    let lastTradeLabel: String?
    let lotCount: Int
    let lots: [OptionLotItem]
    let noTrade: Bool
    let openInterest: String
    let pl: LiveFigure?
    let plDirection: Direction
    let plPct: String
    let plRaw: String?
    let price: String?
    let priceIsEstimate: Bool
    let quantity: String
    let strike: String
    let strikeLabel: String
    let theta: String
    let ticker: String
    let totalCost: String?
    let trend: [TrendDay?]?
    let underlying: String
    let valueRaw: String?
    let vega: String

    enum CodingKeys: String, CodingKey {
        case breakEven = "breakEven"
        case contractType = "contractType"
        case day = "day"
        case dayBasisLabel = "dayBasisLabel"
        case dayPct = "dayPct"
        case daysToExpiry = "daysToExpiry"
        case delta = "delta"
        case entryIsAverage = "entryIsAverage"
        case entryPrice = "entryPrice"
        case expirationDate = "expirationDate"
        case expired = "expired"
        case expiryLabel = "expiryLabel"
        case fees = "fees"
        case gamma = "gamma"
        case hasQuote = "hasQuote"
        case impliedVolatility = "impliedVolatility"
        case key = "key"
        case lastTradeBeyondLookback = "lastTradeBeyondLookback"
        case lastTradeLabel = "lastTradeLabel"
        case lotCount = "lotCount"
        case lots = "lots"
        case noTrade = "noTrade"
        case openInterest = "openInterest"
        case pl = "pl"
        case plDirection = "plDirection"
        case plPct = "plPct"
        case plRaw = "plRaw"
        case price = "price"
        case priceIsEstimate = "priceIsEstimate"
        case quantity = "quantity"
        case strike = "strike"
        case strikeLabel = "strikeLabel"
        case theta = "theta"
        case ticker = "ticker"
        case totalCost = "totalCost"
        case trend = "trend"
        case underlying = "underlying"
        case valueRaw = "valueRaw"
        case vega = "vega"
    }
}

enum ContractType: String, Codable, Sendable {
    case call = "call"
    case put = "put"
}

// MARK: - OptionLotItem
struct OptionLotItem: Codable, Sendable {
    let entryPrice: String
    let entryPriceRaw: String
    let fees: String?
    let feesRaw: String
    let id: String
    let quantity: String
    let quantityRaw: String
    let tradeDate: String
    let tradeDateLabel: String

    enum CodingKeys: String, CodingKey {
        case entryPrice = "entryPrice"
        case entryPriceRaw = "entryPriceRaw"
        case fees = "fees"
        case feesRaw = "feesRaw"
        case id = "id"
        case quantity = "quantity"
        case quantityRaw = "quantityRaw"
        case tradeDate = "tradeDate"
        case tradeDateLabel = "tradeDateLabel"
    }
}

// MARK: - OptionContractRef
struct OptionContractRef: Codable, Sendable {
    let contractType: ContractType
    let expirationDate: String
    let sharesPerContract: String
    let strikeLabel: String
    let strikePrice: String
    let ticker: String
    let underlying: String

    enum CodingKeys: String, CodingKey {
        case contractType = "contractType"
        case expirationDate = "expirationDate"
        case sharesPerContract = "sharesPerContract"
        case strikeLabel = "strikeLabel"
        case strikePrice = "strikePrice"
        case ticker = "ticker"
        case underlying = "underlying"
    }
}

// MARK: - OptionExpirationsResponse
struct OptionExpirationsResponse: Codable, Sendable {
    let expirations: [OptionExpiry]?
    let ok: Bool
    let degraded: Bool?
    let reason: Reason?

    enum CodingKeys: String, CodingKey {
        case expirations = "expirations"
        case ok = "ok"
        case degraded = "degraded"
        case reason = "reason"
    }
}

// MARK: - OptionExpiry
struct OptionExpiry: Codable, Sendable {
    let expirationDate: String
    let label: String

    enum CodingKeys: String, CodingKey {
        case expirationDate = "expirationDate"
        case label = "label"
    }
}

enum Reason: String, Codable, Sendable {
    case signedOut = "signed-out"
    case unavailable = "unavailable"
}

// MARK: - OptionImportResponse
struct OptionImportResponse: Codable, Sendable {
    let extraction: Extraction

    enum CodingKeys: String, CodingKey {
        case extraction = "extraction"
    }
}

// MARK: - Extraction
struct Extraction: Codable, Sendable {
    let brokerSymbolText: String?
    let companyName: String?
    let contractType: ContractType?
    let entryPrice: String?
    let expirationDate: String?
    let fees: String?
    let feesCurrency: String?
    let quantity: String?
    let strikePrice: String?
    let tradeDate: String?
    let underlyingTickerCandidate: String?

    enum CodingKeys: String, CodingKey {
        case brokerSymbolText = "brokerSymbolText"
        case companyName = "companyName"
        case contractType = "contractType"
        case entryPrice = "entryPrice"
        case expirationDate = "expirationDate"
        case fees = "fees"
        case feesCurrency = "feesCurrency"
        case quantity = "quantity"
        case strikePrice = "strikePrice"
        case tradeDate = "tradeDate"
        case underlyingTickerCandidate = "underlyingTickerCandidate"
    }
}

// MARK: - OptionMatchRequest
struct OptionMatchRequest: Codable, Sendable {
    let companyName: String?
    let contractType: ContractType
    let expirationDate: String
    let strikePrice: String
    let underlying: String?

    enum CodingKeys: String, CodingKey {
        case companyName = "companyName"
        case contractType = "contractType"
        case expirationDate = "expirationDate"
        case strikePrice = "strikePrice"
        case underlying = "underlying"
    }
}

// MARK: - OptionMatchResponse
struct OptionMatchResponse: Codable, Sendable {
    let contract: OptionContractRef?
    let status: OptionMatchResponseStatus
    let alternatives: [OptionContractRef]?
    let reason: Reason?

    enum CodingKeys: String, CodingKey {
        case contract = "contract"
        case status = "status"
        case alternatives = "alternatives"
        case reason = "reason"
    }
}

enum OptionMatchResponseStatus: String, Codable, Sendable {
    case degraded = "degraded"
    case matched = "matched"
    case nearby = "nearby"
    case unresolved = "unresolved"
}

// MARK: - OptionStrikesResponse
struct OptionStrikesResponse: Codable, Sendable {
    let contracts: [OptionContractRef]?
    let ok: Bool
    let degraded: Bool?
    let reason: Reason?

    enum CodingKeys: String, CodingKey {
        case contracts = "contracts"
        case ok = "ok"
        case degraded = "degraded"
        case reason = "reason"
    }
}

// MARK: - OptionsPayload
struct OptionsPayload: Codable, Sendable {
    let allSummary: LiveSummary
    let allSummaryNotes: [String]
    let expiredCount: Int
    let items: [OptionCardItem]
    let market: LiveMarket
    let summary: LiveSummary
    let summaryNotes: [String]

    enum CodingKeys: String, CodingKey {
        case allSummary = "allSummary"
        case allSummaryNotes = "allSummaryNotes"
        case expiredCount = "expiredCount"
        case items = "items"
        case market = "market"
        case summary = "summary"
        case summaryNotes = "summaryNotes"
    }
}

// MARK: - PasskeyItem
struct PasskeyItem: Codable, Sendable {
    let backedUp: Bool
    let createdAtISO: String?
    let deviceType: String
    let id: String
    let name: String?

    enum CodingKeys: String, CodingKey {
        case backedUp = "backedUp"
        case createdAtISO = "createdAtISO"
        case deviceType = "deviceType"
        case id = "id"
        case name = "name"
    }
}

// MARK: - PasskeysResponse
struct PasskeysResponse: Codable, Sendable {
    let canRemove: Bool
    let items: [PasskeyItem]

    enum CodingKeys: String, CodingKey {
        case canRemove = "canRemove"
        case items = "items"
    }
}

// MARK: - PortfolioCreated
struct PortfolioCreated: Codable, Sendable {
    let id: String
    let ok: Bool

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case ok = "ok"
    }
}

// MARK: - PortfolioList
struct PortfolioList: Codable, Sendable {
    let portfolios: [Portfolio]

    enum CodingKeys: String, CodingKey {
        case portfolios = "portfolios"
    }
}

// MARK: - PrefillNote
struct PrefillNote: Codable, Sendable {
    let currency: String?
    let feeCurrency: String?
    let kind: Kind
    let pricePerShare: String?
    let quantity: String?
    let reason: String?
    let screenCurrency: String?
    let shown: Shown?

    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case feeCurrency = "feeCurrency"
        case kind = "kind"
        case pricePerShare = "pricePerShare"
        case quantity = "quantity"
        case reason = "reason"
        case screenCurrency = "screenCurrency"
        case shown = "shown"
    }
}

enum Kind: String, Codable, Sendable {
    case currencyMismatch = "currency-mismatch"
    case feeConverted = "fee-converted"
    case feeUnconverted = "fee-unconverted"
    case position = "position"
    case priceCurrencyInferred = "price-currency-inferred"
    case sideAssumed = "side-assumed"
    case sideUnknown = "side-unknown"
    case totalMismatch = "total-mismatch"
}

// MARK: - Shown
struct Shown: Codable, Sendable {
    let from: String
    let fromCurrency: String
    let rate: String
    let to: String
    let toCurrency: String

    enum CodingKeys: String, CodingKey {
        case from = "from"
        case fromCurrency = "fromCurrency"
        case rate = "rate"
        case to = "to"
        case toCurrency = "toCurrency"
    }
}

// MARK: - PriceTargetsResponse
struct PriceTargetsResponse: Codable, Sendable {
    let status: TargetStatus?
    let targets: [PriceTarget]

    enum CodingKeys: String, CodingKey {
        case status = "status"
        case targets = "targets"
    }
}

enum PushTokenEnvironment: String, Codable, Sendable {
    case production = "production"
    case sandbox = "sandbox"
}

// MARK: - PushTokenRequest
struct PushTokenRequest: Codable, Sendable {
    let environment: PushTokenEnvironment
    let token: String

    enum CodingKeys: String, CodingKey {
        case environment = "environment"
        case token = "token"
    }
}

// MARK: - PushTokenResponse
struct PushTokenResponse: Codable, Sendable {
    let ok: Bool

    enum CodingKeys: String, CodingKey {
        case ok = "ok"
    }
}

// MARK: - ScreenshotImportError
struct ScreenshotImportError: Codable, Sendable {
    let error: String
    let reason: ScreenshotImportFailure

    enum CodingKeys: String, CodingKey {
        case error = "error"
        case reason = "reason"
    }
}

enum ScreenshotImportFailure: String, Codable, Sendable {
    case invalidImage = "invalid_image"
    case notConfigured = "not_configured"
    case rateLimited = "rate_limited"
    case refused = "refused"
    case unavailable = "unavailable"
    case unparseable = "unparseable"
}

// MARK: - ScreenshotImportRequest
struct ScreenshotImportRequest: Codable, Sendable {
    let imageBase64: String

    enum CodingKeys: String, CodingKey {
        case imageBase64 = "imageBase64"
    }
}

// MARK: - SeriesPayload
struct SeriesPayload: Codable, Sendable {
    let anchorDate: String?
    let estimatedFrom: String?
    let excludedSymbols: [String]
    let partialDays: Int
    let points: [ChartPoint]

    enum CodingKeys: String, CodingKey {
        case anchorDate = "anchorDate"
        case estimatedFrom = "estimatedFrom"
        case excludedSymbols = "excludedSymbols"
        case partialDays = "partialDays"
        case points = "points"
    }
}

// MARK: - SettingsResponse
struct SettingsResponse: Codable, Sendable {
    let lastPriceFetchedAtMs: Int?
    let marketData: MarketDataHealth
    let recoveryMode: Bool

    enum CodingKeys: String, CodingKey {
        case lastPriceFetchedAtMs = "lastPriceFetchedAtMs"
        case marketData = "marketData"
        case recoveryMode = "recoveryMode"
    }
}

// MARK: - SymbolMatch
struct SymbolMatch: Codable, Sendable {
    let currency: Currency?
    let exchange: String
    let exchangeDisplay: String
    let name: String
    let symbol: String
    let type: SymbolMatchKind

    enum CodingKeys: String, CodingKey {
        case currency = "currency"
        case exchange = "exchange"
        case exchangeDisplay = "exchangeDisplay"
        case name = "name"
        case symbol = "symbol"
        case type = "type"
    }
}

enum SymbolMatchKind: String, Codable, Sendable {
    case equity = "equity"
    case etf = "etf"
}

// MARK: - SymbolSearchResponse
struct SymbolSearchResponse: Codable, Sendable {
    let degraded: Bool?
    let results: [SymbolMatch]

    enum CodingKeys: String, CodingKey {
        case degraded = "degraded"
        case results = "results"
    }
}

// MARK: - TargetRow
struct TargetRow: Codable, Sendable {
    let instrumentId: String
    let symbol: String
    let targetPct: String

    enum CodingKeys: String, CodingKey {
        case instrumentId = "instrumentId"
        case symbol = "symbol"
        case targetPct = "targetPct"
    }
}

// MARK: - TargetsResponse
struct TargetsResponse: Codable, Sendable {
    let rows: [TargetRow]

    enum CodingKeys: String, CodingKey {
        case rows = "rows"
    }
}

// MARK: - TransactionCreated
struct TransactionCreated: Codable, Sendable {
    let id: String
    let ok: Bool

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case ok = "ok"
    }
}

// MARK: - TransactionImportResponse
struct TransactionImportResponse: Codable, Sendable {
    let companyName: String?
    let formPrefill: FormPrefill
    let isin: String?
    let notes: [PrefillNote]
    let priceCurrency: String?
    let priceCurrencyTrusted: Bool
    let readFields: [String]
    let screenKind: ScreenKind?

    enum CodingKeys: String, CodingKey {
        case companyName = "companyName"
        case formPrefill = "formPrefill"
        case isin = "isin"
        case notes = "notes"
        case priceCurrency = "priceCurrency"
        case priceCurrencyTrusted = "priceCurrencyTrusted"
        case readFields = "readFields"
        case screenKind = "screenKind"
    }
}

// MARK: - FormPrefill
struct FormPrefill: Codable, Sendable {
    let fees: String?
    let price: String?
    let quantity: String?
    let side: TransactionSide?
    let symbolQuery: String?
    let tradeDate: String?

    enum CodingKeys: String, CodingKey {
        case fees = "fees"
        case price = "price"
        case quantity = "quantity"
        case side = "side"
        case symbolQuery = "symbolQuery"
        case tradeDate = "tradeDate"
    }
}

enum ScreenKind: String, Codable, Sendable {
    case position = "position"
    case transaction = "transaction"
}

// MARK: - TransactionList
struct TransactionList: Codable, Sendable {
    let transactions: [TransactionRow]

    enum CodingKeys: String, CodingKey {
        case transactions = "transactions"
    }
}

// MARK: - WatchlistPayload
struct WatchlistPayload: Codable, Sendable {
    let hasPollableSymbols: Bool
    let items: [LiveWatchItem]
    let market: LiveMarket

    enum CodingKeys: String, CodingKey {
        case hasPollableSymbols = "hasPollableSymbols"
        case items = "items"
        case market = "market"
    }
}

// MARK: - WatchlistResponse
struct WatchlistResponse: Codable, Sendable {
    let items: [WatchedItem]

    enum CodingKeys: String, CodingKey {
        case items = "items"
    }
}

// MARK: - WidgetDayLines
struct WidgetDayLines: Codable, Sendable {
    let holdings: [WidgetDayPoint]
    let options: [WidgetDayPoint]
    let sessionCloseMs: Int
    let sessionOpenMs: Int

    enum CodingKeys: String, CodingKey {
        case holdings = "holdings"
        case options = "options"
        case sessionCloseMs = "sessionCloseMs"
        case sessionOpenMs = "sessionOpenMs"
    }
}

// MARK: - WidgetDayPoint
struct WidgetDayPoint: Codable, Sendable {
    let p: String
    let t: Int

    enum CodingKeys: String, CodingKey {
        case p = "p"
        case t = "t"
    }
}

// MARK: - WidgetSummaryResponse
struct WidgetSummaryResponse: Codable, Sendable {
    let dayLines: WidgetDayLines?
    let holdings: LiveSummary
    let market: LiveMarket
    let options: LiveSummary

    enum CodingKeys: String, CodingKey {
        case dayLines = "dayLines"
        case holdings = "holdings"
        case market = "market"
        case options = "options"
    }
}
