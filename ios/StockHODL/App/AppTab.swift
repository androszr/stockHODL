import Foundation

/// The four bottom-bar slots, in the web app's order.
///
/// This mirrors `NAV` in `src/components/shell/app-shell.tsx` exactly — same
/// four destinations, same order, same meaning of "active". Two screens that
/// call themselves the same app should not disagree about where things live,
/// so when a slot changes on the web it changes here too.
///
/// Transactions, dividends and settings are deliberately ABSENT, for the same
/// reason they light no tab on the web: all four slots are taken, and each is
/// reached from the screen it belongs to (the journal from Holdings, settings
/// from Profile).
enum AppTab: String, CaseIterable, Hashable, Sendable {
    case dashboard
    case holdings
    case options
    case watchlist

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .holdings: "Holdings"
        case .options: "Options"
        case .watchlist: "Watchlist"
        }
    }

    /// Trading-terminal glyphs, not the lucide set the web bar uses. The four
    /// slots still match `NAV`; the drawings do not — a grid / wallet /
    /// sliders / star read as a generic app, not a book.
    var systemImage: String {
        switch self {
        case .dashboard: "chart.line.uptrend.xyaxis"
        case .holdings: "briefcase"
        case .options: "plusminus"
        case .watchlist: "binoculars"
        }
    }
}
