import Foundation
import Testing

@testable import StockHODL

/// A throwaway defaults domain per test — process-wide state, and a test that
/// wrote the standard suite would decide what an unrelated test opens on.
private func scratchDefaults() -> UserDefaults {
    UserDefaults(suiteName: "test.\(UUID().uuidString)") ?? .standard
}

@Suite("Chart mode")
struct ChartModeTests {
    @Test("the raw values are the wire's, not Swift's")
    func rawValues() {
        // `return` is a Swift keyword, so the case cannot be named for its
        // wire value. The RAW value is what has to match `CHART_MODES`.
        #expect(ChartMode.percentReturn.rawValue == "return")
        #expect(ChartMode.value.rawValue == "value")
        #expect(ChartMode.allCases.map(\.label) == ["Value", "Return"])
    }

    @Test("a remembered mode comes back, and the two surfaces stay separate")
    func remembersPerSurface() {
        let defaults = scratchDefaults()

        ChartMode.percentReturn.remember(for: .portfolio, in: defaults)

        #expect(ChartMode.remembered(for: .portfolio, in: defaults) == .percentReturn)
        // A book of stocks and a book of option contracts are read
        // differently; one shared answer would make a tap on one screen
        // silently change the other.
        #expect(ChartMode.remembered(for: .options, in: defaults) == .value)
    }

    @Test("a value this build no longer has falls back rather than crashing")
    func unknownStoredValue() {
        let defaults = scratchDefaults()
        defaults.set("sharpe", forKey: "chart.mode.portfolio")

        // A downgrade, or a mode dropped between two versions.
        #expect(ChartMode.remembered(for: .portfolio, in: defaults) == .value)
    }
}

@Suite("Chart style")
struct ChartStyleTests {
    @Test("the raw values mirror CHART_STYLES")
    func rawValues() {
        #expect(ChartStyle.allCases.map(\.rawValue) == ["line", "candle"])
        #expect(ChartStyle.allCases.map(\.label) == ["Line", "Candles"])
    }

    @Test("the style is remembered app-wide")
    func remembers() {
        let defaults = scratchDefaults()
        #expect(ChartStyle.remembered(in: defaults) == .line)

        ChartStyle.candle.remember(in: defaults)

        // A user who reads candles reads candles on every stock — remembering
        // per symbol would make the same tap give a different answer.
        #expect(ChartStyle.remembered(in: defaults) == .candle)
    }

    @Test("an unknown stored style falls back to the line")
    func unknownStoredValue() {
        let defaults = scratchDefaults()
        defaults.set("heikin-ashi", forKey: "chart.style")

        #expect(ChartStyle.remembered(in: defaults) == .line)
    }
}

@Suite("Window labels")
struct WindowLabelTests {
    // A label typo is copy on four screens, so the exact list is pinned.
    @Test("every ChartRange names its window")
    func chartRange() {
        #expect(ChartRange.allCases.map(\.windowLabel) == [
            "today", "past 5 days", "past month", "past 6 months",
            "this year", "past year", "past 5 years", "all time",
        ])
    }

    @Test("every OptionsChartRange names its window with the same words")
    func optionsChartRange() {
        #expect(OptionsChartRange.allCases.map(\.windowLabel) == [
            "past month", "past 6 months", "this year", "past year", "all time",
        ])
    }
}

@Suite("Bar colour")
struct BarTokenTests {
    @Test("an up bar, a down bar and a flat bar are three different tokens")
    func threeOutcomes() {
        #expect(ValueChart.barToken(open: 10, close: 12) == Tokens.gain)
        #expect(ValueChart.barToken(open: 12, close: 10) == Tokens.loss)
        // Flat is NEITHER. Painting it green would claim a day that did not
        // happen, and this is the one case a two-way ternary gets wrong.
        #expect(ValueChart.barToken(open: 10, close: 10) == Tokens.textMuted)
    }
}
