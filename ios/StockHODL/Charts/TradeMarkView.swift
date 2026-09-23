import SwiftUI

/// The glyph that sits on the line where a trade happened.
///
/// Direction is carried by the SHAPE first — a triangle pointing up is a buy,
/// down is a sell — with the gain/loss token repeating it. Colour is never the
/// only signal here, the same rule the watch capsule and the extended-hours
/// line follow. A point carrying both a buy and a sell is neither shape and
/// neither colour: a filled dot in the muted token, because a mixed day
/// claiming one direction would be a small lie.
struct TradeMarkGlyph: View {
    let mark: PlacedTradeMark

    /// 11pt reads on the smallest phone without sitting on the line like a
    /// second data series. The TAP target is not this: it is the 24pt hit slop
    /// `ValueChart` measures against, which clears the 44pt floor on diameter.
    private static let size: CGFloat = 11

    var body: some View {
        Image(systemName: TradeMarkGlyph.symbol(for: mark))
            .font(.system(size: TradeMarkGlyph.size, weight: .bold))
            .foregroundStyle(Color(TradeMarkGlyph.token(for: mark)))
            .accessibilityHidden(true)
    }

    static func symbol(for mark: PlacedTradeMark) -> String {
        switch composition(of: mark) {
        case .allBuys: "arrowtriangle.up.fill"
        case .allSells: "arrowtriangle.down.fill"
        case .mixed: "circle.fill"
        }
    }

    static func token(for mark: PlacedTradeMark) -> DesignToken {
        switch composition(of: mark) {
        case .allBuys: Tokens.gain
        case .allSells: Tokens.loss
        case .mixed: Tokens.textMuted
        }
    }

    enum Composition { case allBuys, allSells, mixed }

    static func composition(of mark: PlacedTradeMark) -> Composition {
        let sides = Set(mark.trades.map(\.side))
        if sides == [.buy] { return .allBuys }
        if sides == [.sell] { return .allSells }
        return .mixed
    }
}

/// What a tapped mark says: the same facts the trade's own row shows, worded
/// by whoever built the `TradeMark` so the two can never drift.
///
/// The box is the scrub callout's box — same tokens, same radius — because
/// they appear in the same place over the same plot and two different boxes
/// would read as two different features.
struct TradeMarkCallout: View {
    let mark: PlacedTradeMark

    /// Four lines is already a lot of overlay on a 220pt plot; past three the
    /// tail becomes a count. The transaction list is where all of them live.
    private static let maxLines = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(mark.trades.prefix(TradeMarkCallout.maxLines)) { trade in
                Text(TradeMarkCallout.line(trade))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
            }
            if mark.trades.count > TradeMarkCallout.maxLines {
                Text("+\(mark.trades.count - TradeMarkCallout.maxLines) more")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    /// "BUY · AAPL · 12 @ 231,10 USD · 2026-08-12". The side is a word, not a
    /// colour, and the instrument is named on every surface — even the one
    /// whose whole screen is that instrument — so one callout reads the same
    /// everywhere and a Holdings mark never has to be guessed at.
    static func line(_ trade: TradeMark) -> String {
        let side = trade.side == .buy ? "BUY" : "SELL"
        return "\(side) · \(trade.label) · \(trade.quantityAtPrice) · \(trade.dateText)"
    }
}
