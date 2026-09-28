import Foundation
import Testing

@testable import StockHODL

/// The Dashboard's extended-hours box, in words: its labels per session kind,
/// the priced count, the after-hours footnote and the spoken reading. The
/// figures are the server's; only the words around them are decided here.
@Suite("Extended summary model")
struct ExtendedSummaryModelTests {
    private func summary(
        kind: ExtendedSessionKind,
        priced: Int = 6,
        holdings: Int = 8,
        movers: [LiveExtendedMover] = [
            LiveExtendedMover(pct: LiveFigure(direction: .gain, text: "+1,82%"), symbol: "NVDA"),
            LiveExtendedMover(pct: LiveFigure(direction: .gain, text: "+0,54%"), symbol: "AAPL"),
        ]
    ) -> LiveExtendedSummary {
        LiveExtendedSummary(
            holdingsCount: holdings,
            kind: kind,
            move: LiveFigure(direction: .gain, text: "+184,62 zł (+0,26%)"),
            movePct: "+0,26%",
            movers: movers,
            pricedCount: priced,
            valueAtExtended: "70 422,81 zł"
        )
    }

    @Test("pre-market labels")
    func preMarketLabels() {
        let model = ExtendedSummaryModel.from(summary(kind: .early), isFresh: true)
        #expect(model.title == "Pre-market · holdings")
        #expect(model.valueLabel == "At pre-market prices")
        #expect(model.pricedLabel == "Priced pre-market")
    }

    @Test("after-hours labels")
    func afterHoursLabels() {
        let model = ExtendedSummaryModel.from(summary(kind: .late), isFresh: true)
        #expect(model.title == "After hours · holdings")
        #expect(model.valueLabel == "At after-hours prices")
        #expect(model.pricedLabel == "Priced after hours")
    }

    @Test("the title row: accent dot in pre-market, secondary after hours, and the word live")
    func titleRow() {
        let early = ExtendedSummaryModel.from(summary(kind: .early), isFresh: true)
        let late = ExtendedSummaryModel.from(summary(kind: .late), isFresh: true)
        #expect(early.accentDot == true)
        #expect(late.accentDot == false)
        #expect(early.liveWord == "live")
        #expect(late.liveWord == "live")
    }

    @Test("live is shown and spoken only while the figures are fresh")
    func liveOnlyWhenFresh() {
        let fresh = ExtendedSummaryModel.from(summary(kind: .early), isFresh: true)
        #expect(fresh.liveWord == "live")
        #expect(fresh.spoken.hasPrefix("Pre-market · holdings, live, "))

        // A persisted snapshot or a dropped connection: the StaleBar says the
        // figures are old, so the box must not say "live" beside it.
        let stale = ExtendedSummaryModel.from(summary(kind: .early), isFresh: false)
        #expect(stale.liveWord == nil)
        #expect(!stale.spoken.contains("live"))
        #expect(stale.spoken.hasPrefix("Pre-market · holdings, +184,62 zł (+0,26%), "))
    }

    @Test("the priced text counts holdings, not money")
    func pricedText() {
        #expect(ExtendedSummaryModel.from(summary(kind: .early, priced: 6, holdings: 8), isFresh: true).pricedText == "6 of 8 holdings")
        #expect(ExtendedSummaryModel.from(summary(kind: .late, priced: 8, holdings: 8), isFresh: true).pricedText == "8 of 8 holdings")
    }

    @Test("the footnote is after hours only")
    func footnoteRule() {
        #expect(ExtendedSummaryModel.from(summary(kind: .early), isFresh: true).footnote == nil)
        #expect(ExtendedSummaryModel.from(summary(kind: .late), isFresh: true).footnote
            == "Measured from today's 16:00 close. Not included in Today or Total P/L.")
    }

    @Test("mover chips read ticker then the server's percent, in the server's order")
    func moverTexts() {
        #expect(ExtendedSummaryModel.from(summary(kind: .early), isFresh: true).moverTexts == ["NVDA +1,82%", "AAPL +0,54%"])
        #expect(ExtendedSummaryModel.from(summary(kind: .early, movers: []), isFresh: true).moverTexts.isEmpty)
    }

    @Test("the spoken reading carries every figure, in reading order")
    func spoken() {
        #expect(ExtendedSummaryModel.from(summary(kind: .early), isFresh: true).spoken
            == "Pre-market · holdings, live, +184,62 zł (+0,26%), At pre-market prices 70 422,81 zł, "
            + "Priced pre-market 6 of 8 holdings, Movers NVDA +1,82%, AAPL +0,54%")
        let late = ExtendedSummaryModel.from(summary(kind: .late, movers: []), isFresh: true)
        #expect(late.spoken
            == "After hours · holdings, live, +184,62 zł (+0,26%), At after-hours prices 70 422,81 zł, "
            + "Priced after hours 6 of 8 holdings, "
            + "Measured from today's 16:00 close. Not included in Today or Total P/L.")
    }
}
