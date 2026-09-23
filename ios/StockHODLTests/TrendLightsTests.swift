import Foundation
import Testing

@testable import StockHODL

/// The two things the strip's meaning rests on that are decidable without a
/// screen: the level → height table, and the sentence the tile borrows.
///
/// The GRADING is not retested here — it happens on the server and has its
/// own suite (`src/lib/trend/day-trend.test.ts`). What this pins is that the
/// client re-derives none of it.

private func day(
    _ direction: Direction,
    _ level: Int,
    pct: String = "+1,20%",
    date: String = "2026-08-21"
) -> TrendDay {
    TrendDay(date: date, direction: direction, level: level, pct: pct)
}

@Suite("Trend lights")
struct TrendLightsTests {
    @Test("level maps to four discrete heights and nothing between")
    func heights() {
        #expect(TrendLights.barHeight(for: 0) == 0)
        #expect(TrendLights.barHeight(for: 1) == 1.5)
        #expect(TrendLights.barHeight(for: 2) == 3)
        #expect(TrendLights.barHeight(for: 3) == 5)
    }

    @Test("an unknown level draws no bar rather than a guessed one")
    func unknownLevel() {
        // The contract caps `level` at 3, but it arrives over a wire that a
        // newer server writes: a level 4 must be silent, not full height.
        #expect(TrendLights.barHeight(for: 4) == 0)
        #expect(TrendLights.barHeight(for: -1) == 0)
    }

    @Test("the tallest bar fits inside the strip's own headroom")
    func fitsItsBox() {
        // Two bars plus the hairline is the whole height — the arithmetic the
        // strip's `height` constant is, restated where a change would break it.
        #expect(TrendLights.barHeight(for: 3) * 2 + 1 == TrendLights.height)
    }

    @Test("no trend says nothing at all, so the tile's label is unchanged")
    func silentWhenAbsent() {
        #expect(TrendLights.phrase(for: nil).isEmpty)
        #expect(TrendLights.phrase(for: []).isEmpty)
    }

    @Test("a full week is one clause per session, in order")
    func phrasesAWeek() {
        let phrase = TrendLights.phrase(for: [
            day(.gain, 1, pct: "+0,40%"),
            day(.loss, 2, pct: "-1,80%"),
            day(.neutral, 0, pct: "+0,10%"),
            day(.gain, 3, pct: "+4,20%"),
            day(.gain, 2, pct: "+1,10%"),
        ])

        #expect(phrase == ", last 5 sessions: up 0,40%, down 1,80%, flat, up 4,20%, up 1,10%")
    }

    @Test("the direction word carries the sign, so the glyph is not read twice")
    func doesNotStutterTheSign() {
        #expect(!TrendLights.phrase(for: [day(.loss, 2, pct: "-1,80%")]).contains("down -"))
        #expect(!TrendLights.phrase(for: [day(.gain, 2, pct: "+1,80%")]).contains("up +"))
    }

    @Test("a flat day is named, never given a percentage to argue with")
    func flatIsAWord() {
        // `pct` stays the honest figure on the wire; the phrase reports the
        // grading, and a 0,10% move is not a direction.
        #expect(TrendLights.phrase(for: [day(.neutral, 0, pct: "+0,10%")])
            == ", last 1 session: flat")
    }

    @Test("a hole is named as a hole, not smuggled in as a flat day")
    func holesAreNamed() {
        // The whole reason the wire's entries are nullable. "flat" asserts the
        // price went nowhere; a hole is the absence of any figure, and a
        // screen reader is exactly where the two must not be conflated.
        let phrase = TrendLights.phrase(for: [
            day(.gain, 1, pct: "+3,40%"),
            nil,
            day(.neutral, 0, pct: "+0,90%"),
        ])

        #expect(phrase == ", last 3 sessions: up 3,40%, no data, flat")
    }

    @Test("a strip of nothing but holes says nothing at all")
    func allHolesIsSilent() {
        // Same fact as no strip. A contract that has not traded in a week
        // would otherwise grow a five-clause label saying so five times.
        #expect(TrendLights.phrase(for: [nil, nil, nil, nil, nil]).isEmpty)
    }

    @Test("the summary box speaks its strip, and says so when there is none")
    @MainActor
    func summaryTrendLabel() {
        #expect(SummaryHeader.trendLabel(nil) == "No five-day trend")
        #expect(SummaryHeader.trendLabel([nil, nil]) == "No five-day trend")
        #expect(SummaryHeader.trendLabel([day(.gain, 2), day(.loss, 1, pct: "-0,40%")]) == "last 2 sessions: up 1,20%, down 0,40%")
    }
}
