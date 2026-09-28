import Testing
@testable import StockHODL

/// The Mac sidebar's data (plans/2026-09-28-native-mac-app-stage-1.md). Pure
/// Foundation, so the iPhone test host pins what the Mac window draws.
@Suite("Mac sidebar sections")
struct MacSidebarSectionTests {
    private let tabSections: [MacSidebarSection] = [.dashboard, .holdings, .options, .watchlist]

    @Test("eight sections, tabs first, in the documented order")
    func casesInOrder() {
        #expect(MacSidebarSection.allCases == [
            .dashboard, .holdings, .options, .watchlist,
            .transactions, .dividends, .news, .dayReports,
        ])
    }

    @Test("titles are full words, capitalised — never an abbreviation")
    func fullWordTitles() {
        #expect(MacSidebarSection.allCases.map(\.title) == [
            "Dashboard", "Holdings", "Options", "Watchlist",
            "Transactions", "Dividends", "News", "Day reports",
        ])
        for section in MacSidebarSection.allCases {
            #expect(!section.title.contains("."))
            #expect(section.title.first?.isUppercase == true)
            #expect(!section.systemImage.isEmpty)
        }
    }

    @Test("the four tab sections are their own tab, with no route")
    func tabSectionsAreTabs() {
        for section in tabSections {
            #expect(section.route == nil)
            #expect(section.tab == AppTab(rawValue: section.rawValue))
            #expect(section.systemImage == section.tab.systemImage)
        }
    }

    @Test("the other four push the Holdings tiles' own routes onto Holdings")
    func secondarySectionsPushHoldingsRoutes() {
        let expected: [(MacSidebarSection, HoldingsNavDestination)] = [
            (.transactions, .transactions),
            (.dividends, .dividends),
            (.news, .news),
            (.dayReports, .dayReport),
        ]
        for (section, destination) in expected {
            #expect(section.tab == .holdings)
            #expect(section.route == destination.route)
            #expect(section.systemImage == destination.systemImage)
        }
    }

    @Test("every section round-trips through the window's tab and path")
    func roundTrip() {
        for section in MacSidebarSection.allCases {
            let path = section.route.map { [$0] } ?? []
            #expect(MacSidebarSection.section(for: section.tab, path: path) == section)
        }
    }

    @Test("a stock page on Holdings keeps Holdings highlighted")
    func instrumentStaysOnHoldings() {
        #expect(MacSidebarSection.section(for: .holdings, path: [.instrument("AAPL")]) == .holdings)
        #expect(MacSidebarSection.section(for: .holdings, path: [.instrument("AAPL"), .news("AAPL")]) == .holdings)
    }

    @Test("a push deep link to one day's report highlights Day reports")
    func deepLinkedDayReport() {
        let path: [Route] = [.dayReport(day: "2026-09-25", kind: .close)]
        #expect(MacSidebarSection.section(for: .holdings, path: path) == .dayReports)
    }

    @Test("News pushed from the Watchlist stays on the Watchlist")
    func watchlistNewsStaysOnWatchlist() {
        #expect(MacSidebarSection.section(for: .watchlist, path: [.news(nil)]) == .watchlist)
    }
}
