import Foundation

/// The options chart's FIVE ranges, mirroring `OPTIONS_CHART_RANGES` in
/// `src/lib/charts/ranges.ts`.
///
/// A separate enum rather than a subset of `ChartRange`, and the reason is not
/// tidiness: the option marks are recorded DAILY, so `1D` and `5D` would be
/// tabs that always draw nothing. Offering a control that cannot work is worse
/// than not offering it.
///
/// Hand-written like `ChartRange`, and for the same reason: the range is a
/// QUERY parameter, never a decoded payload, so nothing generates it and a
/// typo here is a 400 naming the offending value rather than a silent
/// fallback.
enum OptionsChartRange: String, CaseIterable, Sendable, ChartRangeOption {
    case oneMonth = "1M"
    case sixMonth = "6M"
    case ytd = "YTD"
    case oneYear = "1Y"
    case all = "ALL"

    var label: String { rawValue }

    /// The same five names `ChartRange` gives these windows — one vocabulary
    /// across every chart.
    var windowLabel: String {
        switch self {
        case .oneMonth: "past month"
        case .sixMonth: "past 6 months"
        case .ytd: "this year"
        case .oneYear: "past year"
        case .all: "all time"
        }
    }

    /// Every options range is daily by construction — there is no intraday
    /// mark to plot.
    var granularity: ChartRange.Granularity { .daily }

    /// `'1M'` on the web, matching `OptionsLive`'s `initialRange` and the
    /// server-rendered first paint. Both clients open the same chart.
    static let fallback: OptionsChartRange = .oneMonth

    private static let key = "options.chart.range"

    static func remembered(in defaults: UserDefaults = .standard) -> OptionsChartRange {
        guard let raw = defaults.string(forKey: key) else { return fallback }
        return OptionsChartRange(rawValue: raw) ?? fallback
    }

    func remember(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: OptionsChartRange.key)
    }
}
