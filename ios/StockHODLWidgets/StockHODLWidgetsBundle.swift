import SwiftUI
import WidgetKit

/// Four widgets, one process.
///
/// Two single-figure Home Screen tiles rather than one configurable widget:
/// they are meant to sit side by side, and two entries in the gallery is a
/// smaller thing to explain than a configuration sheet. They share every line
/// of their view — `SummarySide` is the entire difference — so the
/// duplication is in the gallery, not in the code.
///
/// `CombinedWidget` is the third Home Screen option, for someone who would
/// rather give up one tile's worth of space than a second slot: both totals,
/// one square, never summed (same discipline as the lock screen's two lines).
///
/// The lock-screen widget is separate again because it is not a smaller
/// version of either: it shows both SIDES at once — percentage only, no
/// amounts — which is the only layout that fits the two lines an accessory
/// rectangle gives you, and it is exactly what a glance at a locked phone is
/// for.
///
/// All four share one timeline provider and therefore one refresh policy, and
/// — because they hit the same endpoint within the same wake — one cheap
/// server round trip's worth of work each.
@main
struct StockHODLWidgetsBundle: WidgetBundle {
    var body: some Widget {
        HoldingsWidget()
        OptionsWidget()
        CombinedWidget()
        PortfolioLockScreenWidget()
    }
}

struct HoldingsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "holdings", provider: SummaryProvider()) { entry in
            SummaryWidgetView(entry: entry, side: .holdings)
        }
        .configurationDisplayName("Holdings")
        .description("Your portfolio value, today's move and total return.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

struct OptionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "options", provider: SummaryProvider()) { entry in
            SummaryWidgetView(entry: entry, side: .options)
        }
        .configurationDisplayName("Options")
        // Says the two things that make this number not comparable with the
        // Holdings tile, in the one place the user reads before adding it.
        .description("Your open option lots, in USD.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

struct CombinedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "combined", provider: SummaryProvider()) { entry in
            CombinedSummaryWidgetView(entry: entry)
        }
        .configurationDisplayName("Holdings & Options")
        .description("Both totals in one tile, in their own currencies.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct PortfolioLockScreenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "lockscreen", provider: SummaryProvider()) { entry in
            LockScreenWidgetView(entry: entry)
        }
        .configurationDisplayName("Holdings & Options")
        .description("Today's move for holdings and options, on the lock screen.")
        .supportedFamilies([.accessoryRectangular, .accessoryInline])
    }
}
