import Foundation

/// What the portfolio chart plots — the phone's `CHART_MODES`
/// (`src/lib/charts/mode-preference.ts`).
///
/// Toggling is DISPLAY-ONLY. Both curves ride in the same series payload:
/// every `ChartPoint` carries `v` (value in PLN) and, on a portfolio series,
/// `r` (simple return against the open cost basis, as a percent). So no fetch
/// and no loading state ever hangs off this control — the same guarantee the
/// web's `ModeToggle` makes.
enum ChartMode: String, CaseIterable, Sendable {
    case value
    case percentReturn = "return"

    /// `return` is a Swift keyword, so the case cannot be named for its wire
    /// value; the raw value is what actually has to match the web.
    var label: String {
        switch self {
        case .value: "Value"
        case .percentReturn: "Return"
        }
    }

    static let fallback: ChartMode = .value
}

/// What the instrument price chart draws — the phone's `CHART_STYLES`
/// (`src/lib/charts/style-preference.ts`).
///
/// Also display-only WHERE THE DATA ALLOWS: `o`/`h`/`l` ride the same payload,
/// but only on ranges whose stored bars carry them. A range with no OHLC falls
/// back to the line rather than drawing an empty frame — see
/// `PlotPoints.candles`.
enum ChartStyle: String, CaseIterable, Sendable {
    case line
    case candle

    var label: String {
        switch self {
        case .line: "Line"
        case .candle: "Candles"
        }
    }

    static let fallback: ChartStyle = .line
}

/// Both preferences remember themselves, app-wide, exactly as `ChartRange`
/// does and for the same reason: a user who thinks in candles thinks in
/// candles everywhere, and remembering per symbol would make the same tap give
/// a different answer depending on which card was opened.
///
/// `UserDefaults` rather than the snapshot — a preference, not account data,
/// so a sign-out purge must not take it. It is passed in rather than reached
/// for: it is process-wide state, and a test that writes it decides what an
/// unrelated test opens on.
extension ChartMode {
    /// Which chart is remembering. The web keys these separately
    /// (`MODE_STORAGE_KEYS`) and so does this: a book of stocks and a book of
    /// option contracts are read differently, and one shared answer would make
    /// a tap on one screen silently change the other.
    enum Surface: String, Sendable {
        case portfolio
        case options
    }

    private static func key(_ surface: Surface) -> String {
        "chart.mode.\(surface.rawValue)"
    }

    static func remembered(
        for surface: Surface,
        in defaults: UserDefaults = .standard
    ) -> ChartMode {
        guard let raw = defaults.string(forKey: key(surface)) else { return fallback }
        // An unknown value is a mode this build no longer has — a downgrade,
        // or one dropped between two versions.
        return ChartMode(rawValue: raw) ?? fallback
    }

    func remember(for surface: Surface, in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: ChartMode.key(surface))
    }
}

extension ChartStyle {
    private static let key = "chart.style"

    static func remembered(in defaults: UserDefaults = .standard) -> ChartStyle {
        guard let raw = defaults.string(forKey: key) else { return fallback }
        return ChartStyle(rawValue: raw) ?? fallback
    }

    func remember(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: ChartStyle.key)
    }
}
