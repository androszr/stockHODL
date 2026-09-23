import Foundation

/// The eight ranges, mirroring `CHART_RANGES` in `src/lib/charts/ranges.ts`.
///
/// Hand-written rather than generated, and deliberately so: `chartRangeSchema`
/// sits in the codegen's `NOT_A_TYPE` list because it is a QUERY parameter, not
/// a payload — nothing decodes it, the phone only ever sends it. The raw values
/// are what the server's `z.enum` accepts, so a typo here is a 400 with the
/// offending value named rather than a silent fallback.
enum ChartRange: String, CaseIterable, Sendable {
    case oneDay = "1D"
    case fiveDay = "5D"
    case oneMonth = "1M"
    case sixMonth = "6M"
    case ytd = "YTD"
    case oneYear = "1Y"
    case fiveYear = "5Y"
    case all = "ALL"

    /// What the range tabs print. Identical to the raw value today; kept as its
    /// own property so a future label change cannot silently alter the wire.
    var label: String { rawValue }

    /// The window named for the change row: "+12,40 zł  +3,12%  past month".
    var windowLabel: String {
        switch self {
        case .oneDay: "today"
        case .fiveDay: "past 5 days"
        case .oneMonth: "past month"
        case .sixMonth: "past 6 months"
        case .ytd: "this year"
        case .oneYear: "past year"
        case .fiveYear: "past 5 years"
        case .all: "all time"
        }
    }

    /// Which axis the chart draws. The distinction is not cosmetic — see
    /// `Granularity`.
    var granularity: Granularity {
        switch self {
        case .oneDay, .fiveDay: .intraday
        default: .daily
        }
    }

    /// `DEFAULT_CHART_RANGE` on the web. Both clients open on the same range so
    /// the same portfolio does not greet the user differently on two screens.
    static let fallback: ChartRange = .oneDay

    /// How points are placed on the X axis.
    ///
    /// `intraday` is CATEGORICAL — points sit at their index, evenly spaced,
    /// Yahoo-style. A continuous time axis would draw every overnight and
    /// weekend as a long straight diagonal across half the chart: a closed
    /// market rendered as if it were data. `daily` is continuous, because
    /// weekend gaps at that scale are regular enough not to read as anything.
    enum Granularity: Sendable {
        case intraday
        case daily
    }
}

extension ChartRange {
    /// The remembered range, shared by every chart in the app.
    ///
    /// One key rather than one per instrument: a user who thinks in months
    /// thinks in months everywhere, and remembering per symbol would mean the
    /// same tap gives a different answer depending on which card was opened.
    /// `UserDefaults` rather than the snapshot — a preference, not account
    /// data, so a sign-out purge must not take it.
    /// `UserDefaults` is passed in rather than reached for. It is process-wide
    /// state, and a test that writes it decides what an unrelated test opens on.
    private static let key = "chart.range"

    static func remembered(in defaults: UserDefaults = .standard) -> ChartRange {
        guard let raw = defaults.string(forKey: key) else { return fallback }
        // An unknown value is a range this build no longer has — a downgrade,
        // or one dropped between two versions. Falling back beats a crash on
        // launch, and beats a chart that silently shows the wrong window.
        return ChartRange(rawValue: raw) ?? fallback
    }

    func remember(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: ChartRange.key)
    }
}
