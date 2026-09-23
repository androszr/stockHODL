import Foundation

/// A color the way `src/styles/tokens.css` states it.
///
/// The tokens are authored in OKLCH because that is the space in which the
/// design system's lightness steps are actually perceptually even — the whole
/// reason the palette reads as a scale rather than a list. Flattening them to
/// RGB in the generator would throw that away and hand the client a number
/// nobody could trace back to the CSS.
///
/// No UI framework import on purpose: this is arithmetic, and it is unit-tested
/// as arithmetic.
struct OKLCH: Equatable, Sendable {
    /// Perceptual lightness, 0…1.
    let l: Double
    /// Chroma. Unbounded in principle; in practice ~0…0.4.
    let c: Double
    /// Hue angle in degrees.
    let h: Double

    init(l: Double, c: Double, h: Double) {
        self.l = l
        self.c = c
        self.h = h
    }
}

/// Gamma-encoded color components, 0…1, in whichever RGB space produced them.
struct RGB: Equatable, Sendable {
    let red: Double
    let green: Double
    let blue: Double
}

extension OKLCH {
    /// OKLab, the rectangular form. OKLCH is its polar coordinates.
    private var lab: (l: Double, a: Double, b: Double) {
        let radians = h * .pi / 180
        return (l, c * cos(radians), c * sin(radians))
    }

    /// The cone responses OKLab is defined against, cubed back out of their
    /// cube roots. Björn Ottosson's matrices, unchanged.
    private var lms: (l: Double, m: Double, s: Double) {
        let (lightness, a, b) = lab

        let lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b
        let mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b
        let sRoot = lightness - 0.0894841775 * a - 1.2914855480 * b

        return (lRoot * lRoot * lRoot, mRoot * mRoot * mRoot, sRoot * sRoot * sRoot)
    }

    /// Linear-light sRGB. May fall outside 0…1 — that is what out-of-gamut
    /// means, and it is information, so it is not clamped here.
    var linearSRGB: (red: Double, green: Double, blue: Double) {
        let (l, m, s) = lms
        return (
            red: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            green: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            blue: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
        )
    }

    /// Linear-light Display P3, by way of CIE XYZ (D65).
    ///
    /// iPhone screens are P3, and so is the browser's rendering of these same
    /// `oklch()` values. Going through sRGB instead would visibly desaturate
    /// the gain green and the loss red against the web app sitting next to it.
    var linearDisplayP3: (red: Double, green: Double, blue: Double) {
        let (l, m, s) = lms

        let x = 1.2268798733741557 * l - 0.5578149965554813 * m + 0.2813910501772158 * s
        let y = -0.0405757626243137 * l + 1.1122868293970594 * m - 0.0717110666615170 * s
        let z = -0.0763729497467214 * l - 0.4214933239627914 * m + 1.5869240244272418 * s

        return (
            red: 2.4934969119414254 * x - 0.9313836179191239 * y - 0.4027107844507170 * z,
            green: -0.8294889695615747 * x + 1.7626640603183463 * y + 0.0236246858419436 * z,
            blue: 0.0358458302437845 * x - 0.0761723892680418 * y + 0.9568845240076871 * z
        )
    }

    /// Gamma-encoded sRGB, clamped into range.
    var sRGB: RGB {
        let (red, green, blue) = linearSRGB
        return RGB(
            red: OKLCH.encode(red),
            green: OKLCH.encode(green),
            blue: OKLCH.encode(blue)
        )
    }

    /// Gamma-encoded Display P3, clamped into range. P3 uses the sRGB transfer
    /// function — only the primaries differ.
    var displayP3: RGB {
        let (red, green, blue) = linearDisplayP3
        return RGB(
            red: OKLCH.encode(red),
            green: OKLCH.encode(green),
            blue: OKLCH.encode(blue)
        )
    }

    /// Whether the color survives sRGB without being clipped.
    ///
    /// Worth asserting on in tests rather than discovering on a screen: a token
    /// that leaves the gamut does not fail, it quietly renders as a different,
    /// duller color, and the difference between "designed" and "clipped" is
    /// invisible in a diff.
    var isInSRGBGamut: Bool {
        let (red, green, blue) = linearSRGB
        let tolerance = 0.001
        return [red, green, blue].allSatisfy { $0 >= -tolerance && $0 <= 1 + tolerance }
    }

    /// Whether the color survives Display P3 without being clipped.
    var isInDisplayP3Gamut: Bool {
        let (red, green, blue) = linearDisplayP3
        let tolerance = 0.001
        return [red, green, blue].allSatisfy { $0 >= -tolerance && $0 <= 1 + tolerance }
    }

    /// The sRGB transfer function, plus the clamp. Out-of-gamut components are
    /// clipped per channel — the same thing a browser does, so a token that is
    /// slightly outside renders the same in both clients.
    private static func encode(_ linear: Double) -> Double {
        let clamped = min(max(linear, 0), 1)
        if clamped <= 0.0031308 {
            return clamped * 12.92
        }
        return 1.055 * pow(clamped, 1 / 2.4) - 0.055
    }
}
