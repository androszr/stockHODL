import Testing

@testable import StockHODL

@Suite("Day report history view helpers")
@MainActor
struct DayReportHistoryViewTests {
    @Test("the half is named in plain words")
    func kindLabel() {
        #expect(DayReportHistorySection.kindLabel(.morning) == "Morning brief")
        #expect(DayReportHistorySection.kindLabel(.close) == "Close report")
    }

    @Test("a row routes to the exact day and half the notification would open")
    func route() {
        let close = DayReportHistoryFixture.decodedItem(DayReportHistoryFixture.item(day: "2026-09-19", kind: "close"))
        let morning = DayReportHistoryFixture.decodedItem(DayReportHistoryFixture.item(day: "2026-09-19", kind: "morning"))
        #expect(DayReportHistorySection.route(for: close) == .dayReport(day: "2026-09-19", kind: .close))
        #expect(DayReportHistorySection.route(for: morning) == .dayReport(day: "2026-09-19", kind: .morning))
    }

    @Test("the Today link opens the latest day on its morning half, with no rows needed")
    func todayRoute() {
        #expect(DayReportHistorySection.todayRoute == .dayReport(day: nil, kind: .morning))
    }

    @Test("only a morning row whose figure is another session carries a caption")
    func changeCaption() {
        let close = DayReportHistoryFixture.decodedItem(DayReportHistoryFixture.item(day: "2026-09-17", kind: "close"))
        let morning = DayReportHistoryFixture.decodedItem(DayReportHistoryFixture.item(day: "2026-09-17", kind: "morning"))
        #expect(DayReportHistorySection.changeCaption(close) == nil)
        #expect(DayReportHistorySection.changeCaption(morning) == "Wed 16 Sep close")
    }

    @Test("a missing figure is a dash and a partial one says At least")
    func changeText() {
        let none = DayReportHistoryFixture.decodedItem(DayReportHistoryFixture.item(day: "2026-09-17", change: nil))
        let partial = DayReportHistoryFixture.decodedItem(
            DayReportHistoryFixture.item(day: "2026-09-17", change: "+1,00 zł", partial: true)
        )
        #expect(DayReportHistorySection.changeText(none) == "—")
        #expect(DayReportHistorySection.changeText(partial) == "At least +1,00 zł")
        #expect(none.rowID == "2026-09-17-close")
    }
}
