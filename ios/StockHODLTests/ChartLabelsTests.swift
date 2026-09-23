import Foundation
import Testing

@testable import StockHODL

/// Every wall-clock time this app prints, pinned to two minute digits.
///
/// A bare `minute` field renders `10:0` at the top of an hour — a time missing
/// a digit,
/// beside money. It shipped in five formatters at once because each one looks
/// right for fifty-nine minutes out of sixty. These are the pins; `ios.yml`
/// has the grep that stops the spelling coming back.
///
/// Expectations are BUILT rather than typed: a `DateFormatter` with the SAME
/// locale and the relevant zone states the same truth on a machine in any time
/// zone, which is what a `"10:00"` literal could not do.
struct ChartLabelsTests {
    /// 2026-08-06T08:00:00Z — 10:00 in Warsaw, on the dot.
    private let onTheHour = 1_786_003_200_000
    /// The same day, five minutes later.
    private let fivePast = 1_786_003_500_000

    private func clock(_ ms: Int, zone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = ChartLabels.locale
        formatter.timeZone = zone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(ms) / 1000))
    }

    @Test("The intraday axis label prints both minute digits")
    func hourMinuteIsTwoDigits() {
        #expect(ChartLabels.hourMinute(onTheHour) == clock(onTheHour))
        #expect(ChartLabels.hourMinute(fivePast) == clock(fivePast))
    }

    /// The next instant that is a whole hour in the FORMATTER's own zone.
    ///
    /// `onTheHour` is a whole hour in Warsaw; a machine at +05:30 or +05:45
    /// renders that same instant as ":30" or ":45", and the assertion below
    /// would fail there for a reason that has nothing to do with the bug. So
    /// the instant is CONSTRUCTED to be on the hour wherever the test runs.
    private var wholeHourHere: Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let from = Date(timeIntervalSince1970: TimeInterval(onTheHour) / 1000)
        let onTheDot = calendar.nextDate(
            after: from,
            matching: DateComponents(minute: 0, second: 0),
            matchingPolicy: .nextTime
        ) ?? from
        return Int(onTheDot.timeIntervalSince1970 * 1000)
    }

    /// The regression itself, stated directly: whatever the device's zone, a
    /// whole hour ends in ":00" and never in a bare ":0".
    @Test("A whole hour never renders as a single minute digit")
    func wholeHourKeepsItsZero() {
        let label = ChartLabels.hourMinute(wholeHourHere)

        #expect(label.hasSuffix(":00"))
        // "10:00" — two digits after the colon, never the single one a bare
        // minute field gave.
        #expect(label.split(separator: ":").last?.count == 2)
    }

    @Test("The scrub callout's intraday headline prints both minute digits")
    func scrubbedIntradayIsTwoDigits() {
        for ms in [onTheHour, fivePast] {
            #expect(ChartLabels.scrubbed(ms, granularity: .intraday).hasSuffix(clock(ms)))
        }
    }

    @Test("The since-line inside one session prints both minute digits")
    func sinceWithinASessionIsTwoDigits() {
        for ms in [onTheHour, fivePast] {
            let since = ChartLabels.since(ms, granularity: .intraday, spanMs: 3_600_000)
            #expect(since == clock(ms))
        }
    }

    @Test("The extended-hours instant prints both minute digits")
    func weekdayTimeIsTwoDigits() {
        for ms in [onTheHour, fivePast] {
            #expect(Instants.weekdayTime(ms).hasSuffix(clock(ms)))
        }
    }

    @Test("The cached-price instant prints both minute digits")
    func cachedTimeIsTwoDigits() {
        for ms in [onTheHour, fivePast] {
            #expect(InstrumentView.cachedTime(ms).hasSuffix(clock(ms)))
        }
    }

    /// This one pins Warsaw itself, so the expectation has to as well.
    @Test("Settings' checked-at instant prints both minute digits")
    func fetchedLabelIsTwoDigits() {
        let warsaw = TimeZone(identifier: "Europe/Warsaw") ?? .current
        for ms in [onTheHour, fivePast] {
            #expect(SettingsView.fetchedLabel(ms).hasSuffix(clock(ms, zone: warsaw)))
        }
    }

    @Test("The compact cached clock inherits the same fix")
    func instantsClockIsTwoDigits() {
        #expect(Instants.clock(onTheHour) == clock(onTheHour))
    }
}
