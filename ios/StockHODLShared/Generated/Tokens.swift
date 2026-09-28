//
// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: src/styles/tokens.css.
// Regenerate:      pnpm tokens:gen
//
// Non-negotiable #2: tokens.css is the only file allowed a color literal.
// This file is the iOS half of that rule — generated, never authored. CI
// regenerates it and fails on `git diff --exit-code`.
//
// Values are OKLCH, exactly as the CSS states them. The conversion to a
// renderable color lives in Design/OKLCH.swift.
//

import Foundation

/// A design token: the same hue in both schemes, never one value with a
/// runtime `if`. Which one applies is the renderer's decision, not the
/// token's.
struct DesignToken: Equatable, Sendable {
    let dark: OKLCH
    let light: OKLCH

    func value(for scheme: TokenScheme) -> OKLCH {
        switch scheme {
        case .dark: return dark
        case .light: return light
        }
    }
}

/// Deliberately not `SwiftUI.ColorScheme`: this file stays free of UI
/// framework imports so the token table can be unit-tested anywhere.
enum TokenScheme: Sendable {
    case dark
    case light
}

enum Tokens {
    static let surface0 = DesignToken(
        dark: OKLCH(l: 0.1859, c: 0.0157, h: 261.55),
        light: OKLCH(l: 0.9755, c: 0.0045, h: 258.32)
    )
    static let surface1 = DesignToken(
        dark: OKLCH(l: 0.2337, c: 0.0214, h: 260.54),
        light: OKLCH(l: 1, c: 0, h: 0)
    )
    static let surface2 = DesignToken(
        dark: OKLCH(l: 0.2865, c: 0.0271, h: 257.53),
        light: OKLCH(l: 0.9473, c: 0.0108, h: 256.7)
    )
    static let textPrimary = DesignToken(
        dark: OKLCH(l: 0.9728, c: 0.0057, h: 264.53),
        light: OKLCH(l: 0.2452, c: 0.0305, h: 256.86)
    )
    static let textSecondary = DesignToken(
        dark: OKLCH(l: 0.7961, c: 0.0204, h: 260.17),
        light: OKLCH(l: 0.4845, c: 0.0352, h: 256.1)
    )
    static let textMuted = DesignToken(
        dark: OKLCH(l: 0.6961, c: 0.0279, h: 259.04),
        light: OKLCH(l: 0.5447, c: 0.0337, h: 257.79)
    )
    static let gain = DesignToken(
        dark: OKLCH(l: 0.7944, c: 0.1321, h: 160.94),
        light: OKLCH(l: 0.5079, c: 0.13, h: 157.8)
    )
    static let loss = DesignToken(
        dark: OKLCH(l: 0.7739, c: 0.134, h: 16.09),
        light: OKLCH(l: 0.5286, c: 0.1656, h: 16.28)
    )
    static let neutral = DesignToken(
        dark: OKLCH(l: 0.6961, c: 0.0279, h: 259.04),
        light: OKLCH(l: 0.5447, c: 0.0337, h: 257.79)
    )
    static let sparklineGain = DesignToken(
        dark: OKLCH(l: 0.78, c: 0.18, h: 152),
        light: OKLCH(l: 0.58, c: 0.17, h: 152)
    )
    static let sparklineLoss = DesignToken(
        dark: OKLCH(l: 0.7, c: 0.21, h: 22),
        light: OKLCH(l: 0.56, c: 0.21, h: 22)
    )
    static let accent = DesignToken(
        dark: OKLCH(l: 0.757, c: 0.1238, h: 265.3),
        light: OKLCH(l: 0.5015, c: 0.167, h: 261.57)
    )
    static let accentContrast = DesignToken(
        dark: OKLCH(l: 0.1859, c: 0.0157, h: 261.55),
        light: OKLCH(l: 1, c: 0, h: 0)
    )
    static let borderSubtle = DesignToken(
        dark: OKLCH(l: 0.3, c: 0.012, h: 260),
        light: OKLCH(l: 0.9, c: 0.005, h: 260)
    )
    static let borderStrong = DesignToken(
        dark: OKLCH(l: 0.42, c: 0.014, h: 260),
        light: OKLCH(l: 0.8, c: 0.008, h: 260)
    )
    static let ring = DesignToken(
        dark: OKLCH(l: 0.78, c: 0.13, h: 258),
        light: OKLCH(l: 0.55, c: 0.15, h: 258)
    )
    static let cat1 = DesignToken(
        dark: OKLCH(l: 0.72, c: 0.14, h: 258),
        light: OKLCH(l: 0.55, c: 0.15, h: 258)
    )
    static let cat2 = DesignToken(
        dark: OKLCH(l: 0.74, c: 0.13, h: 190),
        light: OKLCH(l: 0.56, c: 0.13, h: 190)
    )
    static let cat3 = DesignToken(
        dark: OKLCH(l: 0.71, c: 0.14, h: 305),
        light: OKLCH(l: 0.54, c: 0.16, h: 305)
    )
    static let cat4 = DesignToken(
        dark: OKLCH(l: 0.79, c: 0.14, h: 85),
        light: OKLCH(l: 0.62, c: 0.14, h: 85)
    )
    static let cat5 = DesignToken(
        dark: OKLCH(l: 0.75, c: 0.14, h: 140),
        light: OKLCH(l: 0.57, c: 0.14, h: 140)
    )
    static let cat6 = DesignToken(
        dark: OKLCH(l: 0.72, c: 0.14, h: 345),
        light: OKLCH(l: 0.55, c: 0.16, h: 345)
    )
    static let cat7 = DesignToken(
        dark: OKLCH(l: 0.75, c: 0.14, h: 45),
        light: OKLCH(l: 0.58, c: 0.15, h: 45)
    )
    static let cat8 = DesignToken(
        dark: OKLCH(l: 0.7, c: 0.12, h: 225),
        light: OKLCH(l: 0.53, c: 0.13, h: 225)
    )
    static let catUnknown = DesignToken(
        dark: OKLCH(l: 0.6, c: 0.012, h: 260),
        light: OKLCH(l: 0.56, c: 0.012, h: 260)
    )
    static let benchmark = DesignToken(
        dark: OKLCH(l: 0.75, c: 0.03, h: 260),
        light: OKLCH(l: 0.5, c: 0.03, h: 260)
    )

    /// Every token, for the gamut test in StockHODLTests. A token that is
    /// added to the CSS and not to this list would go unchecked.
    static let all: [(name: String, token: DesignToken)] = [
        ("surface-0", surface0),
        ("surface-1", surface1),
        ("surface-2", surface2),
        ("text-primary", textPrimary),
        ("text-secondary", textSecondary),
        ("text-muted", textMuted),
        ("gain", gain),
        ("loss", loss),
        ("neutral", neutral),
        ("sparkline-gain", sparklineGain),
        ("sparkline-loss", sparklineLoss),
        ("accent", accent),
        ("accent-contrast", accentContrast),
        ("border-subtle", borderSubtle),
        ("border-strong", borderStrong),
        ("ring", ring),
        ("cat-1", cat1),
        ("cat-2", cat2),
        ("cat-3", cat3),
        ("cat-4", cat4),
        ("cat-5", cat5),
        ("cat-6", cat6),
        ("cat-7", cat7),
        ("cat-8", cat8),
        ("cat-unknown", catUnknown),
        ("benchmark", benchmark),
    ]
}
