import Foundation
import WidgetKit

/// How the combined tile's header states freshness beside the session badge.
/// The word "Updated" is never dropped: the age is a relative Text from the
/// entry's date and keeps growing if WidgetKit defers a reload, so a bare
/// "Pre-market 1 hr" would read as how long the session has run.
enum WidgetHeaderFreshness: Equatable, Sendable {
    /// "Updated 2 min" — the regular header.
    case updated
    /// "Pre-market  Updated 55 secs" — the badge beside the full words. The
    /// small tile draws it only when the pair fits its header width and
    /// otherwise falls back to plain "Updated" (the Holdings "Pre"/"AH" label
    /// still names the session).
    case badgeBesideUpdated(String)
}

/// One labelled figure row a widget prints — "Pre-market +0,48%".
struct WidgetFigureRow: Equatable, Sendable {
    let label: String
    let text: String
    let direction: Direction?
}

/// What the four widget views say during pre-market and after hours, decided
/// without drawing anything so `WidgetSessionPresentationTests` pins it
/// (plans/2026-09-28-watchlist-grid-extended-hours.md).
///
/// The switch is the server's `summary.extended`: present only while an
/// extended session is LIVE and a holding traded in it, so at 09:30 and 20:00
/// New York time every widget falls back to its regular-session layout with
/// no clock of its own. Every figure is still the server's string.
///
/// Only the Holdings half changes. Options have no extended-hours quotes, so
/// their half keeps its regular figures — relabelled to say "last" in
/// pre-market (`optionsDayLabel`), because at 08:00 New York their "Today"
/// is yesterday's.
enum WidgetSessionPresentation {
    /// "Pre-market" / "After hours" under the name (small) or beside the age
    /// (medium); nil during the regular session and overnight.
    static func badge(_ s: LiveSummary) -> String? {
        switch s.extended?.kind {
        case .early: "Pre-market"
        case .late: "After hours"
        case nil: nil
        }
    }

    /// The combined tile's header: the session badge beside "Updated <age>"
    /// during an extended session, plain "Updated <age>" otherwise — on every
    /// family, fresh or cached, because the age is never a session duration.
    static func headerFreshness(_ s: LiveSummary?) -> WidgetHeaderFreshness {
        guard let s, let label = Self.badge(s) else { return .updated }
        return .badgeBesideUpdated(label)
    }

    /// The small tile's word beside the Holdings percent.
    static func holdingsPercentLabel(_ s: LiveSummary) -> String {
        switch s.extended?.kind {
        case .early: "Pre"
        case .late: "AH"
        case nil: "Today"
        }
    }

    /// The extended move's percent while it exists, today's otherwise. Never
    /// the day figure under a "Pre" label: an extended summary with no percent
    /// (a zero base) prints "—".
    static func holdingsPercent(_ s: LiveSummary) -> String {
        if let extended = s.extended { return extended.movePct ?? "—" }
        return s.dayChangePct ?? "—"
    }

    static func holdingsPercentDirection(_ s: LiveSummary) -> Direction? {
        if let extended = s.extended { return extended.move.direction }
        return s.dayChange?.direction
    }

    /// The big number: the book at extended prices while that session runs.
    static func holdingsValue(_ s: LiveSummary) -> String {
        s.extended?.valueAtExtended ?? s.totalValue ?? "—"
    }

    /// The regular day line's label beside an extended one: in pre-market
    /// the day figure is the previous session's move ("Last close"); after
    /// hours it is still today's.
    static func regularDayLabel(_ s: LiveSummary) -> String {
        s.extended?.kind == .early ? "Last close" : "Today"
    }

    /// The combined medium tile's Holdings rows, percent-only like its
    /// regular layout: the extended move added ABOVE the regular one.
    static func mediumHoldingsRows(_ s: LiveSummary) -> [WidgetFigureRow] {
        let total = WidgetFigureRow(
            label: "Total P/L", text: s.totalChangePct ?? "—", direction: s.totalChange?.direction
        )
        guard let extended = s.extended, let sessionLabel = Self.badge(s) else {
            return [
                WidgetFigureRow(label: "Today", text: s.dayChangePct ?? "—", direction: s.dayChange?.direction),
                total,
            ]
        }
        return [
            WidgetFigureRow(label: sessionLabel, text: extended.movePct ?? "—", direction: extended.move.direction),
            WidgetFigureRow(label: regularDayLabel(s), text: s.dayChangePct ?? "—", direction: s.dayChange?.direction),
            total,
        ]
    }

    /// The single Holdings widget's rows. Small has room for two: the
    /// extended move replaces Today. Larger families keep the regular day
    /// line under it. Text per family through `WidgetSummaryDisplay`.
    static func singleHoldingsRows(_ s: LiveSummary, family: WidgetFamily) -> [WidgetFigureRow] {
        let today = WidgetFigureRow(
            label: "Today",
            text: WidgetSummaryDisplay.change(s, total: false, family: family),
            direction: s.dayChange?.direction
        )
        let total = WidgetFigureRow(
            label: "Total P/L",
            text: WidgetSummaryDisplay.change(s, total: true, family: family),
            direction: s.totalChange?.direction
        )
        guard let extended = s.extended, let sessionLabel = Self.badge(s) else { return [today, total] }
        let move = WidgetFigureRow(
            label: sessionLabel,
            text: WidgetSummaryDisplay.extendedChange(extended, family: family),
            direction: extended.move.direction
        )
        if family == .systemSmall { return [move, total] }
        return [
            move,
            WidgetFigureRow(label: regularDayLabel(s), text: today.text, direction: today.direction),
            total,
        ]
    }

    /// The Options half's day label: the short word on small, the longer
    /// phrase on other families, in pre-market; "Today" otherwise.
    static func optionsDayLabel(market: LiveMarket, family: WidgetFamily) -> String {
        guard market.status == .earlyTrading else { return "Today" }
        return family == .systemSmall ? "Last" : "Last session"
    }

    /// The lock screen's words — the session is stated in words there,
    /// because the tint flattens every colour.
    static func lockLabel(side: SummarySide, summary: LiveSummary) -> String {
        guard side == .holdings else { return side.title }
        switch summary.extended?.kind {
        case .early: return "Holdings · Pre"
        case .late: return "Holdings · AH"
        case nil: return side.title
        }
    }

    static func lockPercent(side: SummarySide, summary: LiveSummary) -> String {
        side == .holdings ? holdingsPercent(summary) : (summary.dayChangePct ?? "—")
    }

    static func lockDirection(side: SummarySide, summary: LiveSummary) -> Direction? {
        side == .holdings ? holdingsPercentDirection(summary) : summary.dayChange?.direction
    }

    /// The spoken name of the lock-screen percent: "pre-market", "after
    /// hours" or "Today".
    static func lockSpokenSession(side: SummarySide, summary: LiveSummary) -> String {
        guard side == .holdings else { return "Today" }
        switch summary.extended?.kind {
        case .early: return "pre-market"
        case .late: return "after hours"
        case nil: return "Today"
        }
    }
}
