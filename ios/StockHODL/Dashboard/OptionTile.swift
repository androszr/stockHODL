import SwiftUI

/// One Dashboard OPTION tile — first ported from the retired web app's option
/// tile; this is now the only implementation.
///
/// Built on the same `TileFrame`/`TilePrice` as the stock tile, so the two are
/// width- and typography-identical by construction rather than by two sets of
/// modifiers that would drift.
///
/// It carries NO manage menu, deliberately: the Dashboard is not a
/// reachability route for a contract, so expired contracts are simply absent
/// here and are reached on the Options tab, where the menu lives.
struct OptionTile: View {
    let item: OptionCardItem

    private var typeSuffix: String { item.contractType == .call ? "C" : "P" }
    private var typeWord: String { item.contractType == .call ? "call" : "put" }

    var body: some View {
        TileFrame {
            TickerLogo(symbol: item.underlying, size: 32, monogramChars: 3)

            // Identity on two lines, `NET` over `$370 C`: at the stock
            // tile's title size the joined `NET $370C` does not fit a cell,
            // and a truncated strike is the one thing a contract tile must
            // never lose.
            Text(item.underlying)
                .font(QuietDesign.TypeRole.tileTitle)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textPrimary))
            Text("$\(item.strikeLabel) \(typeSuffix)")
                .font(QuietDesign.TypeRole.tileFigure)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textPrimary))

            // Expiry, deliberately quiet: it tells two otherwise identical
            // contracts apart, but it is reference detail, not a figure.
            Text(item.expiryLabel)
                .font(.caption2)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textMuted))

            TilePrice(price: item.price, estimate: item.priceIsEstimate)

            TileFigureLine(label: "P/L", value: item.plPct, direction: item.plDirection)

            sessionLine

            // Same strip, same position, same arithmetic as the stock tile;
            // only the grading bands differ, on the server
            // (`src/lib/trend/trend-scale.ts`).
            Spacer(minLength: 0)
            TrendLights(days: item.trend)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(item.underlying) \(item.strikeLabel) \(typeWord), expires \(item.expiryLabel)"
                + (item.priceIsEstimate ? ", estimated price" : "")
                + TrendLights.phrase(for: item.trend)
        )
    }

    @ViewBuilder
    private var sessionLine: some View {
        if let day = item.dayPct {
            TileFigureLine(label: "Day", value: day.text, direction: day.direction)
        } else {
            // The nothing-known case renders a NON-BREAKING SPACE, not an
            // em-dash. The slot still has to hold its line so the tile does
            // not grow when a poll finally brings a figure, but the dash
            // itself earns nothing: it only says "a figure belongs here and we
            // do not have it", which is worth ink when one tile among many is
            // blank and is pure noise when every tile says it at once. That is
            // the ordinary state before the nightly recorder has two evenings
            // to compare. The two cases that DO carry information keep their
            // words.
            Text(mutedSessionText)
                .font(.caption2)
                .lineLimit(1)
                .foregroundStyle(Color(Tokens.textMuted))
        }
    }

    private var mutedSessionText: String {
        if item.lastTradeBeyondLookback { return ">1 mo ago" }
        if item.noTrade, let last = item.lastTradeLabel { return "Last \(last)" }
        return "\u{00a0}"
    }
}
