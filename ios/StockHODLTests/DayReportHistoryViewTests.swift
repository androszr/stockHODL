import Testing

@testable import StockHODL

@Suite("Day report history view helpers")
@MainActor
struct DayReportHistoryViewTests {
    private func items(_ specs: [(String, String)], change: String? = "+100,00 zł", partial: Bool = false) -> [DayReportHistoryItem] {
        specs.map {
            DayReportHistoryFixture.decodedItem(
                DayReportHistoryFixture.item(day: $0.0, kind: $0.1, change: change, partial: partial)
            )
        }
    }

    private func oneDay(_ specs: [(String, String)], change: String? = "+100,00 zł", partial: Bool = false) -> DayReportHistoryDay {
        DayReportHistoryDay.group(items(specs, change: change, partial: partial))[0]
    }

    @Test("two halves of one day become one row")
    func groupsTwoHalvesIntoOneDay() {
        let days = DayReportHistoryDay.group(items([("2026-09-17", "close"), ("2026-09-17", "morning")]))
        #expect(days.count == 1)
        #expect(days[0].morning != nil)
        #expect(days[0].close != nil)
        #expect(days[0].dayLabel == "Thu 17 Sep")
    }

    @Test("days list newest first")
    func newestDayFirst() {
        let days = DayReportHistoryDay.group(
            items([("2026-09-16", "close"), ("2026-09-18", "close"), ("2026-09-17", "morning")])
        )
        #expect(days.map(\.day) == ["2026-09-18", "2026-09-17", "2026-09-16"])
    }

    @Test("a morning-only day shows a dash and no close")
    func morningOnlyDay() {
        let day = oneDay([("2026-09-17", "morning")], change: "+1,00 zł")
        #expect(day.close == nil)
        #expect(day.morning != nil)
        #expect(DayReportHistorySection.changeText(day) == "—")
        #expect(DayReportHistorySection.rowAccessibilityLabel(day) == "Thu 17 Sep, —")
    }

    @Test("a close-only day shows the close figure and no morning")
    func closeOnlyDay() {
        let day = oneDay([("2026-09-17", "close")])
        #expect(day.morning == nil)
        #expect(DayReportHistorySection.changeText(day) == "+100,00 zł")
        #expect(DayReportHistorySection.rowAccessibilityLabel(day) == "Thu 17 Sep, +100,00 zł, +1,00%")
    }

    @Test("a partial close says At least and a missing figure is a dash")
    func partialCloseSaysAtLeast() {
        let partial = oneDay([("2026-09-17", "close")], change: "+1,00 zł", partial: true)
        let none = oneDay([("2026-09-17", "close")], change: nil)
        #expect(DayReportHistorySection.changeText(partial) == "At least +1,00 zł")
        #expect(DayReportHistorySection.changeText(none) == "—")
    }

    @Test("each link routes to the exact half the notification would open")
    func linksRouteToExactHalf() {
        let day = oneDay([("2026-09-17", "close"), ("2026-09-17", "morning")])
        #expect(DayReportHistorySection.route(for: day, kind: .morning) == .dayReport(day: "2026-09-17", kind: .morning))
        #expect(DayReportHistorySection.route(for: day, kind: .close) == .dayReport(day: "2026-09-17", kind: .close))
    }

    @Test("link words and spoken labels")
    func linkWords() {
        #expect(DayReportHistorySection.linkTitle(.morning) == "Open")
        #expect(DayReportHistorySection.linkTitle(.close) == "Close")
        #expect(DayReportHistorySection.linkAccessibilityLabel(kind: .morning, dayLabel: "Thu 17 Sep") == "Open morning brief for Thu 17 Sep")
        #expect(DayReportHistorySection.linkAccessibilityLabel(kind: .close, dayLabel: "Thu 17 Sep") == "Open close report for Thu 17 Sep")
    }

    @Test("a repeated half is ignored")
    func duplicateHalfIsIgnored() {
        let list = items([("2026-09-17", "close"), ("2026-09-17", "close")], change: nil)
        let days = DayReportHistoryDay.group(list)
        #expect(days.count == 1)
        #expect(days[0].close?.rowID == list[0].rowID)
    }

    @Test("the Today link opens the latest day on its morning half, with no rows needed")
    func todayRoute() {
        #expect(DayReportHistorySection.todayRoute == .dayReport(day: nil, kind: .morning))
    }
}
