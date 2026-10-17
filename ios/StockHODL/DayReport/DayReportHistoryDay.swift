import Foundation

/// One trading day on the Dashboard's "Day reports" list: the morning brief and
/// the close report the server wrote for it, either of which may be missing.
/// Built client-side from the loaded history items, so a day whose two reports
/// arrived on different pages is still one entry. Nothing here parses money.
struct DayReportHistoryDay: Identifiable, Sendable {
    let day: String
    let dayLabel: String
    let morning: DayReportHistoryItem?
    let close: DayReportHistoryItem?

    var id: String { day }

    /// Groups by `item.day`, takes the label from the first item seen for a
    /// day, ignores a later duplicate of the same `(day, kind)`, and sorts
    /// newest day first. `day` is ISO `YYYY-MM-DD`, so string order is date
    /// order and no date parsing is needed.
    static func group(_ items: [DayReportHistoryItem]) -> [DayReportHistoryDay] {
        var labels: [String: String] = [:]
        var morning: [String: DayReportHistoryItem] = [:]
        var close: [String: DayReportHistoryItem] = [:]
        for item in items {
            if labels[item.day] == nil { labels[item.day] = item.dayLabel }
            switch item.kind {
            case .morning:
                if morning[item.day] == nil { morning[item.day] = item }
            case .close:
                if close[item.day] == nil { close[item.day] = item }
            }
        }
        return labels.keys.sorted(by: >).map { day in
            DayReportHistoryDay(
                day: day,
                dayLabel: labels[day] ?? day,
                morning: morning[day],
                close: close[day]
            )
        }
    }
}
