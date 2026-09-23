import Foundation
import Testing

@testable import StockHODL

/// The color math, pinned against colors whose sRGB values are not a matter of
/// opinion.
///
/// This exists because the conversion is the one place a design token can go
/// wrong QUIETLY. A wrong matrix coefficient does not crash and does not fail
/// to compile — it ships a palette that is subtly the wrong hue, and nobody
/// notices until the phone is held next to the browser.
@Suite("OKLCH")
struct OKLCHTests {
    /// Comparing gamma-encoded components: a thousandth is well below what a
    /// display can resolve and well above the noise of the matrix round-trip.
    private func expectClose(
        _ actual: RGB,
        _ expected: RGB,
        tolerance: Double = 0.002,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        #expect(abs(actual.red - expected.red) < tolerance, sourceLocation: sourceLocation)
        #expect(abs(actual.green - expected.green) < tolerance, sourceLocation: sourceLocation)
        #expect(abs(actual.blue - expected.blue) < tolerance, sourceLocation: sourceLocation)
    }

    @Test("white and black land exactly where they must")
    func achromaticExtremes() {
        expectClose(OKLCH(l: 1, c: 0, h: 0).sRGB, RGB(red: 1, green: 1, blue: 1))
        expectClose(OKLCH(l: 0, c: 0, h: 0).sRGB, RGB(red: 0, green: 0, blue: 0))
    }

    @Test("zero chroma is grey at every hue and lightness")
    func achromaticIsNeutral() {
        // If a matrix coefficient is mistyped, this is the first thing that
        // breaks: a "grey" that leans green.
        for lightness in [0.16, 0.42, 0.79, 0.97] {
            for hue in [0.0, 60.0, 152.0, 260.0, 359.0] {
                let rgb = OKLCH(l: lightness, c: 0, h: hue).sRGB
                #expect(abs(rgb.red - rgb.green) < 0.0005)
                #expect(abs(rgb.green - rgb.blue) < 0.0005)
            }
        }
    }

    @Test("the sRGB primaries round-trip from their published OKLCH values")
    func primaries() {
        // These triples are what a browser reports for #f00, #0f0 and #00f.
        // Nothing about them is derived from the code under test.
        expectClose(
            OKLCH(l: 0.62796, c: 0.25768, h: 29.234).sRGB,
            RGB(red: 1, green: 0, blue: 0)
        )
        expectClose(
            OKLCH(l: 0.86644, c: 0.29483, h: 142.495).sRGB,
            RGB(red: 0, green: 1, blue: 0)
        )
        expectClose(
            OKLCH(l: 0.45201, c: 0.31321, h: 264.052).sRGB,
            RGB(red: 0, green: 0, blue: 1)
        )
    }

    @Test("Display P3 holds a color sRGB cannot")
    func p3IsWider() {
        // A saturated green well outside sRGB. The point of going through P3
        // at all is that this renders as designed on the phone instead of
        // being flattened to the edge of the smaller gamut.
        let vivid = OKLCH(l: 0.87, c: 0.32, h: 142)
        #expect(!vivid.isInSRGBGamut)
        #expect(vivid.isInDisplayP3Gamut)
    }

    /// The one token the palette places outside even Display P3.
    ///
    /// `--ring` dark is `oklch(0.78 0.13 258)`, whose blue channel overshoots
    /// by ~0.04 in linear P3. The browser clips it exactly the same way, so
    /// the phone matching the web means clipping too — this is recorded rather
    /// than fixed. It is listed by name instead of being tolerated silently: if
    /// this set ever grows, somebody should look at the palette rather than at
    /// the test.
    private static let clipsByDesign: Set<String> = ["ring"]

    @Test("every design token survives Display P3, except the one that does not")
    func tokensAreInGamut() {
        // A token that leaves the gamut does not fail — it silently renders as
        // a duller, different color, and that difference is invisible in a
        // diff. Catching it here is the only place it is cheap.
        for (name, token) in Tokens.all where !Self.clipsByDesign.contains(name) {
            #expect(token.dark.isInDisplayP3Gamut, "dark \(name) is outside Display P3")
            #expect(token.light.isInDisplayP3Gamut, "light \(name) is outside Display P3")
        }
    }

    @Test("the known clipper is only just outside, not wildly so")
    func knownClipperStaysMarginal() {
        // Keeps the allowance above from becoming a place to hide a real
        // mistake: a token that overshoots by 0.04 clips invisibly, one that
        // overshoots by 0.4 is a different color.
        let (red, green, blue) = Tokens.ring.dark.linearDisplayP3
        for component in [red, green, blue] {
            #expect(component > -0.05 && component < 1.05)
        }
    }

    @Test("Display P3 is what earns three of these tokens their saturation")
    func p3EarnsItsKeep() {
        // The reason the generator emits OKLCH and converts at runtime instead
        // of shipping pre-flattened sRGB. These three are outside sRGB and
        // inside P3, so flattening would visibly dull them against the browser
        // rendering the identical `oklch()` value on the same phone.
        #expect(!Tokens.sparklineLoss.dark.isInSRGBGamut)
        #expect(Tokens.sparklineLoss.dark.isInDisplayP3Gamut)

        #expect(!Tokens.gain.light.isInSRGBGamut)
        #expect(Tokens.gain.light.isInDisplayP3Gamut)

        #expect(!Tokens.sparklineGain.light.isInSRGBGamut)
        #expect(Tokens.sparklineGain.light.isInDisplayP3Gamut)
    }

    @Test("a token resolves to a different color per scheme")
    func schemesDiffer() {
        // Guards the generator as much as the math: if the light block were
        // ever parsed as a copy of the dark one, every screen would render
        // dark-on-dark in light mode and the tests would otherwise be silent.
        #expect(Tokens.surface0.value(for: .dark) != Tokens.surface0.value(for: .light))
        #expect(Tokens.surface0.value(for: .dark).l < Tokens.surface0.value(for: .light).l)
        #expect(Tokens.textPrimary.value(for: .dark).l > Tokens.textPrimary.value(for: .light).l)
    }

    @Test("the palette carries every token the CSS defines")
    func tokenCoverage() {
        // Cheap tripwire on the generator: the count only moves when
        // tokens.css moves, and a silent drop would take a color with it.
        #expect(Tokens.all.count == 26)
        #expect(Tokens.all.map(\.name).contains("gain"))
        #expect(Tokens.all.map(\.name).contains("loss"))
    }
}
