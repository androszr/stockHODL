import Foundation

/// When the system should wake the widget again.
///
/// A widget does not poll. It hands WidgetKit a date and is reloaded at
/// roughly that time — WidgetKit itself still enforces its own system-wide
/// reload budget across every widget on the phone (a few dozen a day), so
/// asking for every 5 minutes (288/day) is a REQUEST, not a guarantee; the
/// system may space actual reloads out further than this.
///
/// Five minutes, clamped to the next New York session boundary
/// (plans/2026-09-28-watchlist-grid-extended-hours.md): the widgets switch
/// their Holdings label to "Pre"/"AH" at 04:00 and 16:00 and back at 09:30
/// and 20:00, and a reload asked for just after each boundary is what makes
/// the label change on time rather than up to five minutes late. Market
/// status is still not read — the server's payload says which session it
/// is; this only decides when to ask. `now` is passed in, never read, so
/// this stays trivially testable.
enum WidgetReloadPolicy {
    static let fixedInterval: TimeInterval = 5 * 60
    /// The floor: never ask for a reload sooner than this, even when a
    /// boundary is closer — a reload loop at the boundary would spend the
    /// budget on identical figures.
    static let minimumInterval: TimeInterval = 60

    /// The next reload after a payload arrived. `market` is accepted, not
    /// read — the interval does not branch on session state — so the call
    /// site in `SummaryProvider` needs no change.
    static func next(after market: LiveMarket, now: Date) -> Date {
        _ = market
        let cadence = now.addingTimeInterval(fixedInterval)
        let boundary = NYSessionBoundaries.next(after: now)
        return max(now.addingTimeInterval(minimumInterval), min(cadence, boundary))
    }

    /// The next reload after a failure — no payload, so no session to follow.
    static func retry(now: Date) -> Date {
        now.addingTimeInterval(fixedInterval)
    }
}

/// The four wall-clock instants in New York at which the widget's session
/// labels change: 04:00 (pre-market opens), 09:30 (regular open), 16:00
/// (close, after hours opens) and 20:00 (after hours ends).
///
/// Resolved through a Gregorian calendar pinned to the New York zone, so a
/// daylight-saving week lands on the wall-clock hour rather than on UTC
/// arithmetic, and the device's own zone never enters into it (the
/// `NYCalendar` rule in `PlotPoints.swift`). Weekends are skipped; holidays
/// are not known here and cost one harmless reload of unchanged figures.
enum NYSessionBoundaries {
    static let zone = TimeZone(identifier: "America/New_York")!
    /// Lands the fetch just after the server's own status flip.
    static let grace: TimeInterval = 30

    private static let wallClock: [(hour: Int, minute: Int)] = [
        (4, 0), (9, 30), (16, 0), (20, 0),
    ]

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    /// The earliest weekday boundary strictly after `now`, plus the grace.
    static func next(after now: Date) -> Date {
        let calendar = Self.calendar
        let today = calendar.startOfDay(for: now)
        // A week ahead always contains a weekday; the loop ends far sooner.
        for offset in 0...7 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: today) else { continue }
            // 1 = Sunday, 7 = Saturday in the Gregorian calendar.
            let weekday = calendar.component(.weekday, from: day)
            if weekday == 1 || weekday == 7 { continue }
            var components = calendar.dateComponents([.year, .month, .day], from: day)
            for (hour, minute) in wallClock {
                components.hour = hour
                components.minute = minute
                components.second = 0
                if let instant = calendar.date(from: components), instant > now {
                    return instant.addingTimeInterval(grace)
                }
            }
        }
        // Unreachable: some weekday falls within any seven days.
        return now.addingTimeInterval(WidgetReloadPolicy.fixedInterval)
    }
}
