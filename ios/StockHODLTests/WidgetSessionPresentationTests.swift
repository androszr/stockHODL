import Foundation
import Testing
import WidgetKit

@testable import StockHODL

/// What the widgets say during pre-market and after hours — pinned on the
/// Foundation-only decisions the four widget views share.
@Suite("Widget session presentation")
struct WidgetSessionPresentationTests {
    private func summary(_ kind: ExtendedSessionKind?, movePct: String? = "+0,48%") -> LiveSummary {
        LiveSummary(
            dayChange: LiveFigure(direction: .loss, text: "−4 150,00 zł (−0,63%)"),
            dayChangePct: "−0,63%",
            excludedSymbols: [],
            extended: kind.map { kind in
                LiveExtendedSummary(
                    holdingsCount: 8,
                    kind: kind,
                    move: LiveFigure(direction: kind == .early ? .gain : .loss,
                                     text: kind == .early ? "+3 145,45 zł (+0,48%)" : "−2 031,43 zł (−0,31%)"),
                    movePct: movePct,
                    movers: [],
                    pricedCount: 6,
                    valueAtExtended: kind == .early ? "658 446,66 zł" : "653 269,78 zł"
                )
            },
            partialDayChange: false,
            totalChange: LiveFigure(direction: .loss, text: "−12 400,00 zł (−1,85%)"),
            totalChangePct: "−1,85%",
            totalValue: "655 301,21 zł",
            trend: nil
        )
    }

    private func market(_ status: MarketStatus) -> LiveMarket {
        LiveMarket(nextTransitionAtMs: nil, nextTransitionKind: nil, pollingResumesAtMs: nil,
                   serverNowMs: 1_754_800_000_000, status: status)
    }

    @Test("the badge names the session in full words, and is absent otherwise")
    func badge() {
        #expect(WidgetSessionPresentation.badge(summary(.early)) == "Pre-market")
        #expect(WidgetSessionPresentation.badge(summary(.late)) == "After hours")
        #expect(WidgetSessionPresentation.badge(summary(nil)) == nil)
    }

    @Test("header: the badge sits beside Updated during an extended session")
    func headerBadge() {
        #expect(WidgetSessionPresentation.headerFreshness(summary(.early)) == .badgeBesideUpdated("Pre-market"))
        #expect(WidgetSessionPresentation.headerFreshness(summary(.late)) == .badgeBesideUpdated("After hours"))
    }

    @Test("header: the word Updated is never replaced — no case drops it")
    func headerKeepsUpdated() {
        // A deferred reload grows the relative age; "Pre-market 1 hr" alone
        // would read as a session duration. Both cases the rule has render
        // the full "Updated <age>"; the badge only ever sits beside it.
        let early = WidgetSessionPresentation.headerFreshness(summary(.early))
        #expect(early == .badgeBesideUpdated("Pre-market"))
        #expect(early != .updated)
    }

    @Test("header: no extended session, or no payload, is the regular Updated header")
    func headerRegular() {
        #expect(WidgetSessionPresentation.headerFreshness(summary(nil)) == .updated)
        #expect(WidgetSessionPresentation.headerFreshness(nil) == .updated)
    }

    @Test("the small tile's Holdings label: Pre, AH, or Today")
    func percentLabel() {
        #expect(WidgetSessionPresentation.holdingsPercentLabel(summary(.early)) == "Pre")
        #expect(WidgetSessionPresentation.holdingsPercentLabel(summary(.late)) == "AH")
        #expect(WidgetSessionPresentation.holdingsPercentLabel(summary(nil)) == "Today")
    }

    @Test("the Holdings percent and direction follow the extended move while it exists")
    func percent() {
        #expect(WidgetSessionPresentation.holdingsPercent(summary(.early)) == "+0,48%")
        #expect(WidgetSessionPresentation.holdingsPercentDirection(summary(.early)) == .gain)
        #expect(WidgetSessionPresentation.holdingsPercent(summary(nil)) == "−0,63%")
        #expect(WidgetSessionPresentation.holdingsPercentDirection(summary(nil)) == .loss)
        // Never the day figure under a "Pre" label.
        #expect(WidgetSessionPresentation.holdingsPercent(summary(.early, movePct: nil)) == "—")
    }

    @Test("the big number is the value at extended prices during the session")
    func value() {
        #expect(WidgetSessionPresentation.holdingsValue(summary(.early)) == "658 446,66 zł")
        #expect(WidgetSessionPresentation.holdingsValue(summary(.late)) == "653 269,78 zł")
        #expect(WidgetSessionPresentation.holdingsValue(summary(nil)) == "655 301,21 zł")
    }

    @Test("medium rows: extended above the regular line, which reads Last close in pre-market")
    func mediumRows() {
        #expect(WidgetSessionPresentation.mediumHoldingsRows(summary(.early)) == [
            WidgetFigureRow(label: "Pre-market", text: "+0,48%", direction: .gain),
            WidgetFigureRow(label: "Last close", text: "−0,63%", direction: .loss),
            WidgetFigureRow(label: "Total P/L", text: "−1,85%", direction: .loss),
        ])
        #expect(WidgetSessionPresentation.mediumHoldingsRows(summary(.late)).map(\.label)
            == ["After hours", "Today", "Total P/L"])
        #expect(WidgetSessionPresentation.mediumHoldingsRows(summary(nil)).map(\.label)
            == ["Today", "Total P/L"])
    }

    @Test("single Holdings widget: small swaps Today for the extended move; medium keeps both")
    func singleRows() {
        let small = WidgetSessionPresentation.singleHoldingsRows(summary(.early), family: .systemSmall)
        #expect(small.map(\.label) == ["Pre-market", "Total P/L"])
        #expect(small.first?.text == "+0,48%")
        let medium = WidgetSessionPresentation.singleHoldingsRows(summary(.late), family: .systemMedium)
        #expect(medium.map(\.label) == ["After hours", "Today", "Total P/L"])
        #expect(medium.first?.text == "−2 031,43 zł (−0,31%)")
        #expect(WidgetSessionPresentation.singleHoldingsRows(summary(nil), family: .systemSmall).map(\.label)
            == ["Today", "Total P/L"])
    }

    @Test("options relabel only in pre-market: Last on small, Last session elsewhere")
    func optionsLabel() {
        #expect(WidgetSessionPresentation.optionsDayLabel(market: market(.earlyTrading), family: .systemSmall) == "Last")
        #expect(WidgetSessionPresentation.optionsDayLabel(market: market(.earlyTrading), family: .systemMedium) == "Last session")
        #expect(WidgetSessionPresentation.optionsDayLabel(market: market(.lateTrading), family: .systemSmall) == "Today")
        #expect(WidgetSessionPresentation.optionsDayLabel(market: market(.marketStatusOpen), family: .systemMedium) == "Today")
    }

    @Test("lock screen: the session in words beside a percent, Holdings only")
    func lockScreen() {
        #expect(WidgetSessionPresentation.lockLabel(side: .holdings, summary: summary(.early)) == "Holdings · Pre")
        #expect(WidgetSessionPresentation.lockLabel(side: .holdings, summary: summary(.late)) == "Holdings · AH")
        #expect(WidgetSessionPresentation.lockLabel(side: .holdings, summary: summary(nil)) == "Holdings")
        #expect(WidgetSessionPresentation.lockLabel(side: .options, summary: summary(.early)) == "Options")
        #expect(WidgetSessionPresentation.lockPercent(side: .holdings, summary: summary(.late)) == "+0,48%")
        #expect(WidgetSessionPresentation.lockPercent(side: .options, summary: summary(.late)) == "−0,63%")
        #expect(WidgetSessionPresentation.lockSpokenSession(side: .holdings, summary: summary(.early)) == "pre-market")
    }
}
