import Foundation

/// The Mac window's sidebar: every section the phone has, in one list
/// (plans/2026-09-28-native-mac-app-stage-1.md).
///
/// The phone reaches four of these through its bottom tabs and the other
/// four by pushing a route onto the Holdings stack. The Mac keeps exactly
/// that model underneath — a sidebar row is a tab plus, optionally, the route
/// the phone would push — so the screens, the per-tab stacks and the push
/// deep links are the phone's, unchanged.
///
/// Compiled on BOTH platforms (Foundation only) so the iPhone test host can
/// pin it; only `MacShell.swift` draws it.
enum MacSidebarSection: String, CaseIterable, Hashable, Sendable {
    case dashboard
    case holdings
    case options
    case watchlist
    case transactions
    case dividends
    case news
    case dayReports

    /// Full words — the visible label AND what VoiceOver reads.
    var title: String {
        switch self {
        case .dashboard: AppTab.dashboard.title
        case .holdings: AppTab.holdings.title
        case .options: AppTab.options.title
        case .watchlist: AppTab.watchlist.title
        case .transactions: "Transactions"
        case .dividends: "Dividends"
        case .news: "News"
        case .dayReports: "Day reports"
        }
    }

    /// The phone's own glyphs: the tab bar's for the four tabs, the Holdings
    /// tiles' for the rest, so one destination looks the same on both.
    var systemImage: String {
        if let destination { return destination.systemImage }
        return tab.systemImage
    }

    /// The phone tab that owns the section's stack. The four secondary
    /// sections live on Holdings, where the phone pushes them.
    var tab: AppTab {
        switch self {
        case .dashboard: .dashboard
        case .holdings, .transactions, .dividends, .news, .dayReports: .holdings
        case .options: .options
        case .watchlist: .watchlist
        }
    }

    /// The route pushed onto `tab`'s stack, or nil for a tab's own root. Read
    /// from `HoldingsNavDestination`, so a change to the phone's route
    /// changes the Mac's with it.
    var route: Route? { destination?.route }

    private var destination: HoldingsNavDestination? {
        switch self {
        case .dashboard, .holdings, .options, .watchlist: nil
        case .transactions: .transactions
        case .dividends: .dividends
        case .news: .news
        case .dayReports: .dayReport
        }
    }

    /// Which row to highlight for where the window actually is — after a push
    /// deep link, a tap inside a screen, or a sidebar click. A Holdings stack
    /// whose FIRST route is one of the four secondary destinations names that
    /// section, whatever its argument (a push to one day's report is still
    /// Day reports); anything else is the tab's own section. Only Holdings
    /// counts: the Watchlist's News row pushes onto the Watchlist stack, and
    /// highlighting "News" there would move the window off the Watchlist.
    static func section(for tab: AppTab, path: [Route]) -> MacSidebarSection {
        if tab == .holdings, let first = path.first {
            switch first {
            case .transactions: return .transactions
            case .dividends: return .dividends
            case .news: return .news
            case .dayReport: return .dayReports
            default: break
            }
        }
        switch tab {
        case .dashboard: return .dashboard
        case .holdings: return .holdings
        case .options: return .options
        case .watchlist: return .watchlist
        }
    }
}
