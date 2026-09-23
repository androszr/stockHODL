import SwiftUI

/// The row of market tiles across the top of the Dashboard — S&P 500, Nasdaq,
/// Dow and USD/PLN — the native shape of the row every big finance app opens
/// with: how is the market doing, read before how your own money is doing.
///
/// **The disclosure is the feature, not a footnote.** The real index feeds are
/// not entitled on this data plan, so each tile follows the fund that tracks
/// its index and says `via SPY` / `via QQQ` / `via DIA` under its title. That
/// caption renders unconditionally — including in the no-quote state, where
/// there is no number to attribute and the tile must still say what it is
/// about. A tile that showed a level without naming the fund would be passing
/// an ETF's price off as an index's own.
///
/// Four equal columns and no `ScrollView`: 343 pt of content at the narrowest
/// supported width leaves ~80 pt per tile, so the row fits every iPhone the
/// app supports with no horizontal scrolling and no breakpoint branch. The
/// captions shrink (`minimumScaleFactor`) rather than truncate, and
/// `TilePrice` truncates the amount's tail only.
///
/// Every tile is a push (2026-09-20): `NavigationLink(value: Route.marketDetail(key))`
/// opens the read-only market screen for that tile. `.buttonStyle(.plain)`
/// keeps the tile's own colours; the button trait is what tells VoiceOver
/// the tile is something you can activate.
///
/// `fx` is optional at THIS seam only so the view stays constructible
/// without a payload (previews, a three-tile fixture); on the wire the tile
/// is required, and `MarketStripStore.fx` is nil only before the first
/// payload lands.
struct MarketIndexStrip: View {
    let tiles: [IndexTile]
    let fx: CurrencyTile?
    let freshness: Freshness

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                ForEach(tiles, id: \.proxySymbol) { tile in
                    NavigationLink(value: Route.marketDetail(tile.key)) {
                        IndexTileView(tile: tile)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isButton)
                }

                if let fx {
                    NavigationLink(value: Route.marketDetail(fx.key)) {
                        CurrencyTileView(tile: fx)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isButton)
                }
            }

            // Smaller chrome than `StaleBar` deliberately: the Dashboard
            // already carries the holdings' bar above this, and two full-width
            // strips saying the same kind of thing would read as an outage.
            // Same WORDING though — `StaleLabel` is the app's single source of
            // the staleness sentence, and it answers nil while fresh.
            StaleCaption(freshness: freshness)
        }
    }
}

/// One index tile: what it is about, where the number came from, the day's
/// shape, the level, and the day's move.
///
/// Every figure is a pre-formatted string from the server. Nothing is parsed
/// back, nothing is re-derived, and the direction arrives as the server's own
/// `directionOf()` verdict rather than as a ternary on a sign here.
struct IndexTileView: View {
    let tile: IndexTile

    var body: some View {
        TileFrame {
            Text(tile.indexName)
                .font(.system(.caption, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textPrimary))

            // The proxy disclosure. Quiet, but never conditional and never
            // truncated away — `minimumScaleFactor` shrinks it rather than
            // letting it become "via S…".
            Text("via \(tile.proxySymbol)")
                .font(.system(size: 10))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textMuted))

            Sparkline(points: tile.spark, direction: tile.dayPct?.direction ?? .neutral)

            TilePrice(price: tile.last)

            // The SIGN is the non-colour carrier of direction — the server's
            // `fmtPct` writes it, and it is there whether or not the colour is
            // perceivable. `TickerTile.sessionLine`'s else-branch, verbatim.
            Text(tile.dayPct?.text ?? "—")
                .font(.system(size: 11))
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(
                    Color(tile.dayPct.map { $0.direction.token } ?? Tokens.textMuted)
                )

            // The same five-session lights every holding's tile draws, on the
            // proxy's daily closes (2026-09-21).
            TrendLights(days: tile.trend)
        }
        // One element, not five: a tile is a single thing to a screen reader,
        // and the figures repaint on every poll — separate elements would be
        // five swipe stops re-announcing themselves.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel + TrendLights.phrase(for: tile.trend))
    }

    /// One sentence naming the index, the fund it follows, the reading and the
    /// day's move — the same four facts the tile draws, in the same order. The
    /// fund is in here for the same reason it is on screen: a spoken level
    /// with no attribution is the same misattribution as a printed one.
    private var accessibilityLabel: String {
        let level = tile.last ?? "no reading"
        let move = tile.dayPct.map { "\($0.text) today" } ?? "no change figure today"
        return "\(tile.indexName), via \(tile.proxySymbol), \(level), \(move)"
    }
}

/// The USD/PLN tile: the pair, what the figure means, the day's shape, the
/// rate to four decimals, and the day's move.
///
/// The caption slot carries `PLN per 1 USD` where an index tile carries
/// `via SPY` — the same register, the same reason: a bare "3,7955" beside
/// three index levels says nothing about what it is. Every figure is a
/// pre-formatted string from the server; the rate has no whitespace, so
/// `splitMoney` inside `TilePrice` hands it back whole with no currency
/// suffix to demote.
///
/// The figures refresh on the STRIP's cadence — the US market's poll gate,
/// plus every foreground and pull-to-refresh — not around the clock. Deliberate:
/// widening the gate for one tile is the all-night polling bug
/// `MarketStripStore`'s comment records.
struct CurrencyTileView: View {
    let tile: CurrencyTile

    var body: some View {
        TileFrame {
            Text(tile.pairLabel)
                .font(.system(.caption, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textPrimary))

            Text(tile.caption)
                .font(.system(size: 10))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textMuted))

            Sparkline(points: tile.spark, direction: tile.dayPct?.direction ?? .neutral)

            TilePrice(price: tile.last)

            Text(tile.dayPct?.text ?? "—")
                .font(.system(size: 11))
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(
                    Color(tile.dayPct.map { $0.direction.token } ?? Tokens.textMuted)
                )

            // Five UTC-day lights on the pair's daily closes, graded on the
            // server's FX bands rather than the equity ones.
            TrendLights(days: tile.trend)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel + TrendLights.phrase(for: tile.trend))
    }

    /// "USD/PLN, złoty per dollar, 3,7955, +0,12% today" — the same four
    /// facts the tile draws, in the same order, with the unit spelled out.
    private var accessibilityLabel: String {
        let level = tile.last ?? "no reading"
        let move = tile.dayPct.map { "\($0.text) today" } ?? "no change figure today"
        return "\(tile.pairLabel), złoty per dollar, \(level), \(move)"
    }
}
