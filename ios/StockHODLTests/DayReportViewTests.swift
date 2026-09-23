import Testing

@testable import StockHODL

@MainActor
@Suite("Day report view helpers")
struct DayReportViewTests {
    @Test("a partial headline carries the At least disclosure")
    func partialHeadline() {
        #expect(DayReportView.headline("+123,00 zł", partial: true) == "At least +123,00 zł")
        #expect(DayReportView.headline("+123,00 zł", partial: false) == "+123,00 zł")
    }

    @Test("narrative states map to stable sentences")
    func narrativeStateSentence() {
        #expect(NarrativeSection.stateSentence(.pending) == "Writing…")
        #expect(NarrativeSection.stateSentence(.unavailable) == "No narrative for this day")
        #expect(NarrativeSection.stateSentence(.ready) == nil)
    }

    @Test("mover fractions clamp to the closed unit interval")
    func moverFraction() {
        #expect(MoverBars.fraction("-20") == 0)
        #expect(MoverBars.fraction("37.5") == 0.375)
        #expect(MoverBars.fraction("180") == 1)
    }

    @Test("only HTTPS narrative sources become links")
    func secureSourceLinks() {
        #expect(NarrativeSection.sourceURL("https://example.com/story") != nil)
        #expect(NarrativeSection.sourceURL("http://example.com/story") == nil)
        #expect(NarrativeSection.sourceURL("javascript:alert(1)") == nil)
    }

    @Test("the Events card shows the writer's dated list once the report is ready")
    func writerEvents() {
        let events = """
        [{"date":"2026-09-19","symbol":null,"title":"Fed minutes, 14:00 ET"},
         {"date":"2026-09-23","symbol":"NKE","title":"Q1 FY27 earnings, after the close"}]
        """
        let view = DayReportFixture.decoded(DayReportFixture.payload(events: events))
        #expect(DayReportView.eventRows(view) == [
            DayReportView.EventRow(when: "Today", date: nil, text: "Fed minutes, 14:00 ET"),
            DayReportView.EventRow(when: "Wed", date: "23 Sep", text: "NKE · Q1 FY27 earnings, after the close"),
        ])
    }

    @Test("an event past this week carries its day of the month beside the weekday")
    func eventDateLabel() {
        #expect(DayReportView.dateLabel("2026-10-01", today: "2026-09-21") == "1 Oct")
        #expect(DayReportView.dateLabel("2026-09-21", today: "2026-09-21") == nil)
        #expect(DayReportView.dateLabel("not-a-day", today: "2026-09-21") == nil)
    }

    @Test("without a written list the Events card falls back to the feed's own items")
    func feedEventsFallback() {
        let view = DayReportFixture.decoded(DayReportFixture.payload())
        #expect(DayReportView.eventRows(view).isEmpty)
    }

    @Test("a portfolio scope cannot retain the options mover selection")
    func moverSelectionWithoutOptions() {
        #expect(DayReportView.usesOptionMovers(1, optionsAvailable: true))
        #expect(!DayReportView.usesOptionMovers(1, optionsAvailable: false))
        #expect(!DayReportView.usesOptionMovers(0, optionsAvailable: true))
    }
}
