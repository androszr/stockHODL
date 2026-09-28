import Foundation
import Testing

@testable import StockHODL

/// The refresh cadence, in test form: five minutes, clamped to the next New
/// York session boundary (04:00, 09:30, 16:00, 20:00 wall clock, weekdays)
/// plus a 30 s grace, never sooner than a minute — and still no branch on
/// market status.
@Suite("WidgetReloadPolicy")
struct WidgetReloadPolicyTests {
    private static var ny: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }

    /// A New York wall-clock instant.
    private func nyDate(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int, _ second: Int = 0) -> Date {
        let components = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
        return Self.ny.date(from: components)!
    }

    private func nyClock(_ date: Date) -> DateComponents {
        Self.ny.dateComponents([.weekday, .day, .hour, .minute, .second], from: date)
    }

    private func market(_ status: MarketStatus, now: Date, resumesAt: Date? = nil) -> LiveMarket {
        LiveMarket(
            nextTransitionAtMs: nil,
            nextTransitionKind: nil,
            pollingResumesAtMs: resumesAt.map { Int($0.timeIntervalSince1970 * 1000) },
            serverNowMs: Int(now.timeIntervalSince1970 * 1000),
            status: status
        )
    }

    /// Tuesday 22 September 2026, 11:00 New York — hours from any boundary.
    private var midSession: Date { nyDate(2026, 9, 22, 11, 0) }

    @Test(
        "five minutes when no boundary is nearer, whatever the market status",
        arguments: [
            MarketStatus.marketStatusOpen, .earlyTrading, .lateTrading, .closed, .unknown,
        ]
    )
    func fixedWhenNoBoundaryIsNearer(status: MarketStatus) {
        let now = midSession
        let next = WidgetReloadPolicy.next(after: market(status, now: now), now: now)
        #expect(next.timeIntervalSince(now) == WidgetReloadPolicy.fixedInterval)
    }

    @Test("a named resume instant does not change the interval")
    func resumeInstantIsIgnored() {
        let now = midSession
        let open = now.addingTimeInterval(9 * 60 * 60)
        let next = WidgetReloadPolicy.next(after: market(.closed, now: now, resumesAt: open), now: now)
        #expect(next.timeIntervalSince(now) == WidgetReloadPolicy.fixedInterval)
    }

    @Test("09:27 New York on a weekday reloads at 09:30:30, not 09:32")
    func clampsToTheOpen() {
        let now = nyDate(2026, 9, 22, 9, 27)
        let next = WidgetReloadPolicy.next(after: market(.earlyTrading, now: now), now: now)
        #expect(next == nyDate(2026, 9, 22, 9, 30, 30))
        #expect(next.timeIntervalSince(now) == 210)
    }

    @Test("each of the four boundaries is honoured", arguments: [(4, 0), (9, 30), (16, 0), (20, 0)])
    func everyBoundary(hour: Int, minute: Int) {
        let boundary = nyDate(2026, 9, 23, hour, minute)
        let now = boundary.addingTimeInterval(-120)
        #expect(NYSessionBoundaries.next(after: now) == boundary.addingTimeInterval(NYSessionBoundaries.grace))
        #expect(WidgetReloadPolicy.next(after: market(.closed, now: now), now: now)
            == boundary.addingTimeInterval(NYSessionBoundaries.grace))
    }

    @Test("a boundary that has just passed is not asked for again")
    func strictlyAfter() {
        let now = nyDate(2026, 9, 22, 16, 0, 10)
        #expect(NYSessionBoundaries.next(after: now) == nyDate(2026, 9, 22, 20, 0, 30))
    }

    @Test("never sooner than the one-minute floor, even right before a boundary")
    func minimumFloor() {
        let now = nyDate(2026, 9, 22, 9, 29, 45)
        let next = WidgetReloadPolicy.next(after: market(.earlyTrading, now: now), now: now)
        #expect(next.timeIntervalSince(now) == WidgetReloadPolicy.minimumInterval)
    }

    @Test("Friday 21:00 New York: the next boundary is Monday 04:00:30")
    func weekendIsSkipped() {
        let friday = nyDate(2026, 9, 25, 21, 0)
        let next = NYSessionBoundaries.next(after: friday)
        #expect(next == nyDate(2026, 9, 28, 4, 0, 30))
        let clock = nyClock(next)
        #expect(clock.weekday == 2) // Monday
        // The policy itself still asks again in five minutes.
        #expect(WidgetReloadPolicy.next(after: market(.closed, now: friday), now: friday)
            .timeIntervalSince(friday) == WidgetReloadPolicy.fixedInterval)
    }

    @Test("across the March daylight-saving change the boundary is wall-clock, not UTC arithmetic")
    func daylightSavingWeek() {
        // US clocks spring forward on Sunday 8 March 2026. Friday 21:00 EST to
        // Monday 04:00 EDT is 55 wall-clock hours but only 54 real ones.
        let friday = nyDate(2026, 3, 6, 21, 0)
        let next = NYSessionBoundaries.next(after: friday)
        let clock = nyClock(next)
        #expect(clock.day == 9)
        #expect(clock.hour == 4)
        #expect(clock.minute == 0)
        #expect(clock.second == 30)
        #expect(next.timeIntervalSince(friday) == 54 * 3600 + 30)

        // And a weekday 09:27 in the new offset still lands on 09:30:30 local.
        let monday = nyDate(2026, 3, 9, 9, 27)
        #expect(NYSessionBoundaries.next(after: monday).timeIntervalSince(monday) == 210)
    }

    @Test("a failure retries on the fixed interval")
    func retry() {
        let now = midSession
        let next = WidgetReloadPolicy.retry(now: now)
        #expect(next.timeIntervalSince(now) == WidgetReloadPolicy.fixedInterval)
    }
}
