import Foundation

/// When the system should wake the widget again.
///
/// A widget does not poll. It hands WidgetKit a date and is reloaded at
/// roughly that time — WidgetKit itself still enforces its own system-wide
/// reload budget across every widget on the phone (a few dozen a day), so
/// asking for every 5 minutes (288/day) is a REQUEST, not a guarantee; the
/// system may space actual reloads out further than this. That trade was
/// made deliberately: a fixed cadence is simpler to reason about than a
/// session-aware one, at the cost of some requested reloads being skipped
/// overnight or on a closed market instead of being spent on stale figures.
///
/// Fixed and unconditional, regardless of market status — no session-aware
/// branching. `now` is passed in, never read, so this stays trivially
/// testable.
enum WidgetReloadPolicy {
    static let fixedInterval: TimeInterval = 5 * 60

    /// The next reload after a payload arrived. `market` is accepted, not
    /// read — the interval no longer branches on session state — so the call
    /// site in `SummaryProvider` needs no change.
    static func next(after market: LiveMarket, now: Date) -> Date {
        _ = market
        return now.addingTimeInterval(fixedInterval)
    }

    /// The next reload after a failure — no payload, so no session to follow.
    static func retry(now: Date) -> Date {
        now.addingTimeInterval(fixedInterval)
    }
}
