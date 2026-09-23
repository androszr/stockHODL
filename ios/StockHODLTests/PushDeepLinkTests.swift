import Foundation
import Testing

@testable import StockHODL

@Suite("PushDeepLink")
struct PushDeepLinkTests {
    @Test("a well-formed ticker link resolves to its symbol")
    func wellFormed() {
        let url = URL(string: "stockhodl://ticker/AAPL")!
        #expect(PushDeepLink.symbol(from: url) == "AAPL")
    }

    @Test("the raw-string form used by a notification payload matches")
    func fromString() {
        #expect(PushDeepLink.symbol(fromURLString: "stockhodl://ticker/TSLA") == "TSLA")
    }

    @Test("a class-share symbol with a dot survives the path segment")
    func dottedSymbol() {
        let url = URL(string: "stockhodl://ticker/BRK.B")!
        #expect(PushDeepLink.symbol(from: url) == "BRK.B")
    }

    @Test("a foreign scheme is not ours")
    func foreignScheme() {
        let url = URL(string: "https://ticker/AAPL")!
        #expect(PushDeepLink.symbol(from: url) == nil)
    }

    @Test("a foreign host under our own scheme is not a ticker link")
    func foreignHost() {
        let url = URL(string: "stockhodl://something-else/AAPL")!
        #expect(PushDeepLink.symbol(from: url) == nil)
    }

    @Test("no symbol segment at all comes back nil, not an empty string")
    func missingSymbol() {
        let url = URL(string: "stockhodl://ticker/")!
        #expect(PushDeepLink.symbol(from: url) == nil)
    }

    @Test("an unparseable string comes back nil rather than crashing")
    func unparseableString() {
        #expect(PushDeepLink.symbol(fromURLString: "not a url") == nil)
    }

    // MARK: - Destinations

    @Test("a morning report link carries its day and selected half")
    func morningDayReport() {
        let url = URL(string: "stockhodl://day-report/2026-09-19?kind=morning")!
        #expect(PushDeepLink.destination(from: url) == .dayReport(day: "2026-09-19", kind: .morning))
    }

    @Test("a report link without a kind defaults to close")
    func defaultDayReportKind() {
        let url = URL(string: "stockhodl://day-report/2026-09-19")!
        #expect(PushDeepLink.destination(from: url) == .dayReport(day: "2026-09-19", kind: .close))
    }

    @Test("a report link requires exactly one day segment")
    func dayReportSegmentCount() {
        #expect(PushDeepLink.destination(fromURLString: "stockhodl://day-report") == nil)
        #expect(PushDeepLink.destination(fromURLString: "stockhodl://day-report/2026-09-19/extra") == nil)
    }

    @Test("a report day must use the ISO date shape")
    func dayReportDateShape() {
        #expect(PushDeepLink.destination(fromURLString: "stockhodl://day-report/19-09-2026") == nil)
    }

    @Test("an unknown report kind is rejected")
    func unknownDayReportKind() {
        #expect(PushDeepLink.destination(fromURLString: "stockhodl://day-report/2026-09-19?kind=foo") == nil)
    }

    @Test("duplicate report kinds are rejected")
    func duplicateDayReportKind() {
        #expect(PushDeepLink.destination(fromURLString: "stockhodl://day-report/2026-09-19?kind=close&kind=morning") == nil)
    }

    @Test("the dashboard link resolves to the dashboard destination")
    func dashboardDestination() {
        let url = URL(string: "stockhodl://dashboard")!
        #expect(PushDeepLink.destination(from: url) == .dashboard)
    }

    @Test("the raw-string dashboard form used by a notification payload matches")
    func dashboardFromString() {
        #expect(PushDeepLink.destination(fromURLString: "stockhodl://dashboard") == .dashboard)
    }

    @Test("a ticker link resolves to the ticker destination with its symbol")
    func tickerDestination() {
        let url = URL(string: "stockhodl://ticker/AAPL")!
        #expect(PushDeepLink.destination(from: url) == .ticker("AAPL"))
    }

    @Test("a dashboard link carrying a path is not one this app writes")
    func dashboardWithExtraPath() {
        let url = URL(string: "stockhodl://dashboard/extra")!
        #expect(PushDeepLink.destination(from: url) == nil)
    }

    @Test("a foreign scheme is no destination either")
    func foreignSchemeDestination() {
        let url = URL(string: "https://dashboard")!
        #expect(PushDeepLink.destination(from: url) == nil)
    }

    @Test("an unknown host under our scheme is no destination")
    func unknownHostDestination() {
        let url = URL(string: "stockhodl://something-else")!
        #expect(PushDeepLink.destination(from: url) == nil)
    }

    @Test("an unparseable destination string comes back nil rather than crashing")
    func unparseableDestinationString() {
        #expect(PushDeepLink.destination(fromURLString: "not a url") == nil)
    }

    @Test("the dashboard destination never answers the ticker-only parse")
    func dashboardIsNotASymbol() {
        #expect(PushDeepLink.symbol(fromURLString: "stockhodl://dashboard") == nil)
    }
}
