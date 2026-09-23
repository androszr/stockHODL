import Testing
@testable import StockHODL

@Suite("Holdings navigation")
struct HoldingsNavTests {
    @Test("five destinations, in reading order")
    func casesInOrder() {
        // News is LAST: it was added after the fact, and the three tiles
        // already in muscle memory keep the positions they have.
        #expect(HoldingsNavDestination.allCases == [.transactions, .dividends, .analytics, .dayReport, .news])
    }

    @Test("titles are full words — what VoiceOver speaks is never an abbreviation")
    func fullWordTitles() {
        for destination in HoldingsNavDestination.allCases {
            #expect(!destination.title.isEmpty)
            // The abbreviation guard: "Trans." / "Divid." / "Analyt." would
            // pass a non-empty check and still be read aloud as nonsense.
            #expect(!destination.title.contains("."))
        }
    }

    @Test("every tile has a glyph")
    func systemImages() {
        for destination in HoldingsNavDestination.allCases {
            #expect(!destination.systemImage.isEmpty)
        }
    }

    @Test("every tile routes to its own screen")
    func routes() {
        #expect(HoldingsNavDestination.transactions.route == Route.transactions)
        #expect(HoldingsNavDestination.dividends.route == Route.dividends(nil))
        #expect(HoldingsNavDestination.analytics.route == Route.analytics)
        #expect(HoldingsNavDestination.dayReport.route == Route.dayReport(day: nil, kind: .close))
        // `nil` — the unfiltered feed, the same one the Watchlist row opens.
        #expect(HoldingsNavDestination.news.route == Route.news(nil))

        // Pairwise distinct — two tiles opening one screen would pass the
        // per-case checks above only if one of them were rewritten wrongly,
        // but the set makes the property explicit.
        let routes = HoldingsNavDestination.allCases.map(\.route)
        #expect(Set(routes).count == routes.count)
    }
}
