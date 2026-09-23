import Foundation

/// Parses the price-alert notification's tap target — a private URL scheme,
/// `stockhodl://ticker/AAPL` — into the symbol `RootView` pushes.
///
/// A PRIVATE scheme rather than a universal link (plans/2026-08-20-price-move-push-alerts.md
/// decision #4): the AASA file at `/.well-known/apple-app-site-association`
/// deliberately publishes `webcredentials` only, with no `applinks` — widening
/// it would make every `sawa-finance.vercel.app` link try to open the app,
/// which is a real security surface this feature does not need to open.
///
/// Pure and isomorphic so it is testable without a notification, a URL open,
/// or any app state.
enum PushDeepLink {
    /// `stockhodl` — must match the `CFBundleURLTypes` entry in both
    /// `Config/Info.plist` and `Config/Info-Debug.plist`, and the `urlScheme`
    /// this client's server side writes in `src/lib/push/apns.ts`.
    static var urlScheme: String { "stockhodl" }

    /// Where a tapped notification lands. Three destinations: a stock's own
    /// page, the legacy Dashboard summary target, and an exact Day report.
    enum Destination: Equatable, Sendable {
        case ticker(String)
        case dashboard
        case dayReport(day: String, kind: DayReportKind)
    }

    /// The destination to open, or nil if this URL is not one of ours (a
    /// malformed payload, or a scheme collision from another app entirely —
    /// neither should crash or navigate anywhere).
    static func destination(from url: URL) -> Destination? {
        guard url.scheme == urlScheme else { return nil }
        switch url.host {
        case "ticker":
            let segments = url.pathComponents.filter { $0 != "/" }
            guard let first = segments.first, !first.isEmpty else { return nil }
            return .ticker(first)
        case "dashboard":
            // Host only, no path — `stockhodl://dashboard/extra` is not a
            // link this app ever writes, so it is not one it opens.
            guard url.pathComponents.filter({ $0 != "/" }).isEmpty else { return nil }
            return .dashboard
        case "day-report":
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                return nil
            }
            let segments = url.pathComponents.filter { $0 != "/" }
            guard segments.count == 1,
                  segments[0].range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
            else { return nil }
            let kindItems = components.queryItems?.filter { $0.name == "kind" } ?? []
            guard kindItems.count <= 1 else { return nil }
            let kind: DayReportKind
            if let raw = kindItems.first?.value {
                guard let parsed = DayReportKind(rawValue: raw) else { return nil }
                kind = parsed
            } else {
                kind = .close
            }
            return .dayReport(day: segments[0], kind: kind)
        default:
            return nil
        }
    }

    /// The same parse, from the raw string a notification payload's `url`
    /// field carries — `didReceive response:` has a string, not a `URL`.
    static func destination(fromURLString string: String) -> Destination? {
        guard let url = URL(string: string) else { return nil }
        return destination(from: url)
    }

    /// The original ticker-only parse, delegating to `destination(from:)` so
    /// there is exactly one grammar for the scheme.
    static func symbol(from url: URL) -> String? {
        guard case let .ticker(symbol) = destination(from: url) else { return nil }
        return symbol
    }

    /// See `symbol(from:)`.
    static func symbol(fromURLString string: String) -> String? {
        guard case let .ticker(symbol) = destination(fromURLString: string) else { return nil }
        return symbol
    }
}
