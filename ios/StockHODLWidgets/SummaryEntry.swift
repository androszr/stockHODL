import WidgetKit

/// One moment on a widget's timeline.
///
/// Thin on purpose: everything that decides WHAT to show already happened in
/// `WidgetDataSource` (shared, and unit-tested against the app target), and
/// everything that decides WHEN happened in `WidgetReloadPolicy`. This type
/// exists because `TimelineEntry` demands a `date`, and it is the one thing
/// that has to import WidgetKit.
struct SummaryEntry: TimelineEntry {
    let date: Date
    let outcome: WidgetLoadOutcome

    /// What the gallery shows before the widget has ever run, and what a
    /// redacted placeholder is measured against. Real-looking (invented)
    /// figures rather than dashes: a preview of "—" tells the user nothing about what they
    /// are adding, and WidgetKit blurs the values anyway.
    static func placeholder(now: Date = Date()) -> SummaryEntry {
        SummaryEntry(
            date: now,
            outcome: .figures(
                WidgetSummaryResponse(
                    dayLines: WidgetDayLines(
                        holdings: [
                            WidgetDayPoint(p: "0", t: 0),
                            WidgetDayPoint(p: "-0.80", t: 8_000_000),
                            WidgetDayPoint(p: "-0.99", t: 23_400_000),
                        ],
                        options: [
                            WidgetDayPoint(p: "0", t: 0),
                            WidgetDayPoint(p: "-4.90", t: 8_000_000),
                            WidgetDayPoint(p: "-5.88", t: 23_400_000),
                        ],
                        sessionCloseMs: 23_400_000,
                        sessionOpenMs: 0
                    ),
                    holdings: LiveSummary(
                        dayChange: LiveFigure(direction: .loss, text: "-1 250,00 zł (-0,99%)"),
                        dayChangePct: "-0,99%",
                        excludedSymbols: [],
                        partialDayChange: false,
                        totalChange: LiveFigure(direction: .gain, text: "+15 400,00 zł (+14,00%)"),
                        totalChangePct: "+14,00%",
                        totalValue: "125 400,00 zł",
                        trend: nil
                    ),
                    market: LiveMarket(
                        nextTransitionAtMs: nil,
                        nextTransitionKind: nil,
                        pollingResumesAtMs: nil,
                        serverNowMs: Int(now.timeIntervalSince1970 * 1000),
                        status: .closed
                    ),
                    options: LiveSummary(
                        dayChange: LiveFigure(direction: .loss, text: "-$150.00 (-5,88%)"),
                        dayChangePct: "-5,88%",
                        excludedSymbols: [],
                        partialDayChange: false,
                        totalChange: LiveFigure(direction: .gain, text: "+$300.00 (+14,29%)"),
                        totalChangePct: "+14,29%",
                        totalValue: "$2 400.00",
                        trend: nil
                    )
                ),
                capturedAt: nil
            )
        )
    }
}

/// Which half of the payload a widget renders. The two widgets are otherwise
/// the same view, so this is the entire difference between them.
enum SummarySide: Sendable {
    case holdings
    case options

    /// The title the widget prints, matching the app's own tab names.
    var title: String {
        switch self {
        case .holdings: "Holdings"
        case .options: "Options"
        }
    }

    func summary(of payload: WidgetSummaryResponse) -> LiveSummary {
        switch self {
        case .holdings: payload.holdings
        case .options: payload.options
        }
    }
}
