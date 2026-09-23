import Foundation

/// The sentences behind a prefill's notes.
///
/// The FACTS come from the server — which notes exist and when they fire is
/// decided once, in `buildTransactionPrefill` — and only the wording lives
/// here. That split is the same one every other ported screen makes, and it is
/// deliberate: the rules are what must never diverge, while a phone's copy is
/// shorter than a browser's by necessity.
///
/// Every note is a DISCLOSURE. Each exists because this app inferred something
/// from a picture and might have got it wrong, so an unknown kind renders as
/// nothing rather than as a placeholder — but the kinds are a generated enum,
/// so a new one on the server is a compile error here, not a silent gap.
enum PrefillNoteCopy {
    static func sentence(for note: PrefillNote) -> String? {
        switch note.kind {
        case .position:
            return positionSentence(note)

        case .sideAssumed:
            return "The screen doesn't say buy or sell. Buy was assumed because it shows an open position — check it."

        case .sideUnknown:
            return "The screen doesn't say buy or sell — pick one below."

        case .feeConverted:
            return feeConvertedSentence(note)

        case .feeUnconverted:
            return feeUnconvertedSentence(note)

        case .priceCurrencyInferred:
            guard let currency = note.currency else { return nil }
            return "The screen doesn't label the price with a currency, but its total matches quantity × price in \(currency) — so the price and the commission were both read as \(currency)."

        case .currencyMismatch:
            let currency = note.screenCurrency ?? "another currency"
            return "The screen quoted this price in \(currency), but its own figures say otherwise — check the price and the currency before saving."

        case .totalMismatch:
            return "The total on the screen doesn't match quantity × price — check both. A position screen often shows today's market value rather than what you paid."
        }
    }

    /// The position warning is the ENTIRE mitigation for a screen that
    /// collapses several fills into one line, so it names the figures it
    /// filled in — that is what lets someone recognise a position they built
    /// up over several buys.
    private static func positionSentence(_ note: PrefillNote) -> String {
        let figures: String
        if let quantity = note.quantity, let price = note.pricePerShare {
            figures = " — \(quantity) at \(price) — "
        } else {
            figures = " "
        }
        return "This is a position screen, not a single trade. The whole open position was filled in\(figures)as one purchase. If you built it up in several buys, the individual prices and fees are not on that screen."
    }

    private static func feeConvertedSentence(_ note: PrefillNote) -> String? {
        guard let shown = note.shown else { return nil }
        return "Commission on the screen: \(shown.from) \(shown.fromCurrency) ÷ \(shown.rate) (the rate printed on your screenshot) = \(shown.to) \(shown.toCurrency). The field stays editable."
    }

    /// The two reasons must not share a sentence: telling someone there is no
    /// rate while a rate is printed on the screenshot in front of them is a
    /// confidently false explanation.
    private static func feeUnconvertedSentence(_ note: PrefillNote) -> String {
        let currency = note.feeCurrency ?? "another currency"
        if note.reason == "unknown-target" {
            return "The commission is shown in \(currency), but the screen's own figures contradict the currency it printed for the price, so it could not be converted safely. It was set to 0 rather than guessed — fill it in yourself."
        }
        return "The commission is shown in \(currency) and the screenshot carries no rate to convert it with, so it was set to 0 rather than guessed. Fill it in yourself."
    }
}
