import SwiftUI
import UIKit

/// The bridge from a design token to something SwiftUI can paint.
///
/// Kept apart from `OKLCH.swift` on purpose: the math has no UI framework
/// import and is therefore testable anywhere, while everything in this file
/// needs UIKit. That split is what lets `OKLCHTests` run without a simulator.
///
/// No color literal appears here — non-negotiable #2. Every value comes from
/// `Tokens.swift`, which is generated from `src/styles/tokens.css`.

extension UIColor {
    /// Renders into Display P3, which is what the screen actually is.
    ///
    /// Three of this palette's tokens (`sparkline-loss` dark, `gain` light,
    /// `sparkline-gain` light) sit OUTSIDE sRGB and inside P3, so going through
    /// sRGB would visibly dull them — including against a browser rendering the
    /// same `oklch()` value on the same phone. `OKLCHTests` pins that.
    convenience init(_ oklch: OKLCH) {
        let rgb = oklch.displayP3
        self.init(
            displayP3Red: CGFloat(rgb.red),
            green: CGFloat(rgb.green),
            blue: CGFloat(rgb.blue),
            alpha: 1
        )
    }

    /// Follows the system appearance. A dynamic `UIColor` re-resolves itself
    /// when the trait collection changes, so a view painted with one does not
    /// need to observe anything to switch on a light/dark toggle.
    convenience init(_ token: DesignToken) {
        self.init { traits in
            UIColor(token.value(for: traits.userInterfaceStyle == .light ? .light : .dark))
        }
    }
}

extension Color {
    init(_ oklch: OKLCH) {
        self.init(uiColor: UIColor(oklch))
    }

    init(_ token: DesignToken) {
        self.init(uiColor: UIColor(token))
    }
}

extension Direction {
    /// Direction → token, so a sign is never turned into a color at the call
    /// site. `Direction` is the generated contract's enum and `Tokens` is the
    /// generated palette, which means this mapping is the only hand-written
    /// link between the two and the only place it can go wrong.
    var token: DesignToken {
        switch self {
        case .gain: Tokens.gain
        case .loss: Tokens.loss
        case .neutral: Tokens.neutral
        }
    }

    /// The heavier stroke charts use — same hue, tuned for legibility at 1.5pt.
    /// `neutral` has no sparkline variant in the CSS, so it borrows its own.
    var sparklineToken: DesignToken {
        switch self {
        case .gain: Tokens.sparklineGain
        case .loss: Tokens.sparklineLoss
        case .neutral: Tokens.neutral
        }
    }
}
