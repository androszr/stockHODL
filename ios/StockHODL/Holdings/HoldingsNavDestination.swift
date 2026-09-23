import Foundation

/// The five secondary destinations reached from the Holdings screen.
///
/// A data-driven enum rather than inlined links, so the tile row renders
/// one `NavTile` call and a test can prove the titles are FULL words — the
/// visible label may shrink at large text sizes, but what VoiceOver speaks is
/// never an abbreviation.
enum HoldingsNavDestination: CaseIterable {
    case transactions
    case dividends
    case analytics
    case dayReport
    // The feed already covers what you hold, not just what you watch, so the
    // person who lives on this tab should not have to open Watchlist to read
    // about their own stocks. Last, so the three tiles already tapped keep
    // the positions they have.
    case news

    /// The full destination word — the visible label AND what VoiceOver reads.
    var title: String {
        switch self {
        case .transactions: "Transactions"
        case .dividends: "Dividends"
        case .analytics: "Analytics"
        case .dayReport: "Day report"
        case .news: "News"
        }
    }

    var systemImage: String {
        switch self {
        case .transactions: "list.bullet.rectangle"
        case .dividends: "banknote"
        case .analytics: "chart.xyaxis.line"
        case .dayReport: "calendar.day.timeline.left"
        // The glyph the Watchlist's News row already carries: two ways into
        // one screen should look like one destination.
        case .news: "newspaper"
        }
    }

    /// Value-based routes, so the
    /// destination is still built by whoever owns the `NavigationStack`.
    var route: Route {
        switch self {
        case .transactions: .transactions
        case .dividends: .dividends(nil)
        case .analytics: .analytics
        case .dayReport: .dayReport(day: nil, kind: .close)
        // `nil` is the unfiltered feed; a symbol here would narrow it to one.
        case .news: .news(nil)
        }
    }
}
