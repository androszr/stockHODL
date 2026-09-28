import Testing
import WidgetKit

@testable import StockHODL

@Suite("Widget presentation strings")
struct WidgetPresentationTests {
    private var summary: LiveSummary {
        LiveSummary(
            dayChange: LiveFigure(direction: .gain, text: "+12 345,67 PLN (+3,21%)"),
            dayChangePct: "+3,21%",
            excludedSymbols: [], extended: nil, partialDayChange: false,
            totalChange: LiveFigure(direction: .loss, text: "−98 765,43 PLN (−4,56%)"),
            totalChangePct: "−4,56%",
            totalValue: "1 234 567 890,12 PLN", trend: nil
        )
    }

    @Test("small keeps compact server percentages; medium keeps complete server changes")
    func familyChangeText() {
        #expect(WidgetSummaryDisplay.change(summary, total: false, family: .systemSmall) == "+3,21%")
        #expect(WidgetSummaryDisplay.change(summary, total: true, family: .systemSmall) == "−4,56%")
        #expect(WidgetSummaryDisplay.change(summary, total: false, family: .systemMedium) == "+12 345,67 PLN (+3,21%)")
        #expect(WidgetSummaryDisplay.change(summary, total: true, family: .systemMedium) == "−98 765,43 PLN (−4,56%)")
    }

    @Test("the extended change: compact percent on small, the full server text elsewhere")
    func extendedChangeText() {
        let extended = LiveExtendedSummary(
            holdingsCount: 8, kind: .early,
            move: LiveFigure(direction: .gain, text: "+184,62 PLN (+0,26%)"),
            movePct: "+0,26%", movers: [], pricedCount: 6, valueAtExtended: "70 422,81 PLN"
        )
        #expect(WidgetSummaryDisplay.extendedChange(extended, family: .systemSmall) == "+0,26%")
        #expect(WidgetSummaryDisplay.extendedChange(extended, family: .systemMedium) == "+184,62 PLN (+0,26%)")
    }

    @Test("a regular-session summary carries no extended session presentation")
    func regularSessionHasNoBadge() {
        #expect(WidgetSessionPresentation.badge(summary) == nil)
        #expect(WidgetSessionPresentation.holdingsPercentLabel(summary) == "Today")
        #expect(WidgetSessionPresentation.holdingsValue(summary) == "1 234 567 890,12 PLN")
    }

    @Test("missing changes remain explicitly unavailable")
    func missingChange() {
        let missing = LiveSummary(dayChange: nil, dayChangePct: nil, excludedSymbols: [],
                                  extended: nil, partialDayChange: false, totalChange: nil, totalChangePct: nil,
                                  totalValue: nil, trend: nil)
        #expect(WidgetSummaryDisplay.change(missing, total: false, family: .systemSmall) == "—")
        #expect(WidgetSummaryDisplay.change(missing, total: true, family: .systemMedium) == "—")
    }

    private var lines: WidgetDayLines {
        WidgetDayLines(
            holdings: [WidgetDayPoint(p: "0", t: 0), WidgetDayPoint(p: "-0.21", t: 5_400_000)],
            options: [WidgetDayPoint(p: "0", t: 0), WidgetDayPoint(p: "0.80", t: 5_400_000)],
            sessionCloseMs: 23_400_000,
            sessionOpenMs: 0
        )
    }

    @Test("small with day lines draws the plot under the totals")
    func smallWithLinesFillsBelow() {
        let has = CombinedPlotPlacement.hasLines(lines)
        #expect(has)
        #expect(CombinedPlotPlacement.for(family: .systemSmall, hasLines: has) == .fillBelow)
    }

    @Test("medium with day lines draws the plot and its key under the sections")
    func mediumWithLinesFillsBelowWithKey() {
        let has = CombinedPlotPlacement.hasLines(lines)
        #expect(CombinedPlotPlacement.for(family: .systemMedium, hasLines: has) == .fillBelowWithKey)
    }

    @Test("no day lines means no plot in either family")
    func missingLinesPlaceNothing() {
        let has = CombinedPlotPlacement.hasLines(nil)
        #expect(!has)
        #expect(CombinedPlotPlacement.for(family: .systemSmall, hasLines: has) == .none)
        #expect(CombinedPlotPlacement.for(family: .systemMedium, hasLines: has) == .none)
    }

    @Test("day lines with nothing to map count as no lines in either family")
    func emptyLinesPlaceNothing() {
        let empty = WidgetDayLines(holdings: [], options: [], sessionCloseMs: 23_400_000, sessionOpenMs: 0)
        let unparseable = WidgetDayLines(holdings: [WidgetDayPoint(p: "n/a", t: 0)],
                                         options: [WidgetDayPoint(p: "0", t: 0)],
                                         sessionCloseMs: 23_400_000, sessionOpenMs: 0)
        for candidate in [empty, unparseable] {
            let has = CombinedPlotPlacement.hasLines(candidate)
            #expect(!has)
            #expect(CombinedPlotPlacement.for(family: .systemSmall, hasLines: has) == .none)
            #expect(CombinedPlotPlacement.for(family: .systemMedium, hasLines: has) == .none)
        }
    }
}
