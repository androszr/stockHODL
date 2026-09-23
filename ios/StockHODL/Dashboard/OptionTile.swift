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

            // Identity line, `NET $370C`.
            Text("\(item.underlying) $\(item.strikeLabel)\(typeSuffix)")
                .font(.system(.caption, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(Color(Tokens.textPrimary))

            // Expiry, deliberately QUIET: it is the one thing distinguishing
            // two otherwise identical-looking contracts, so it has to be
            // present — but it is reference detail, not a figure to scan.
            Text(item.expiryLabel)
                .font(.system(size: 10))
                .monospacedDigit()
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(Color(Tokens.textMuted))

            TilePrice(price: item.price, estimate: item.priceIsEstimate)

            HStack(spacing: 3) {
                Text("P/L").foregroundStyle(Color(Tokens.textMuted))
                Text(item.plPct)
                    .monospacedDigit()
                    .foregroundStyle(Color(item.plDirection.token))
            }
            .font(.system(size: 11))
            .lineLimit(1)

            sessionLine

            // Same strip, same position, same arithmetic as the stock tile —
            // the two sit side by side in one grid and a difference here would
            // read as a difference in the instrument. Only the GRADING BANDS
            // differ, and they differ on the server
            // (`src/lib/trend/trend-scale.ts`), where the reason for them can
            // be stated once.
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
            Text(day.text)
                .font(.system(size: 11))
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(Color(day.direction.token))
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
                .font(.system(size: 11))
                .monospacedDigit()
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
