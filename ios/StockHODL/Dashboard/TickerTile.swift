import SwiftUI

/// The shared tile CHROME — first ported from the retired web app's tile frame.
///
/// Extracted from the tile itself for the same reason the web extracted it:
/// the stock tile and the option tile must be identical in border, radius,
/// spacing and typography BY CONSTRUCTION, not by two parallel sets of
/// modifiers that drift the first time one is touched. Presentational only —
/// no data, no loader, no store.
struct TileFrame<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 2) {
            content
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(Tokens.surface1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }
}

/// The price line, with the currency demoted.
///
/// On a grid of tiles the currency is the most repeated and least informative
/// glyph on screen — every US ticker says USD — so it drops a step in size and
/// to the muted token while the number keeps the primary colour. It stays
/// VISIBLE and stays on the same line: a Warsaw listing beside a US one would
/// otherwise be two bare numbers in two currencies, which is worse than a
/// slightly busy tile.
///
/// Baseline alignment keeps the smaller token sitting on the number's baseline
/// instead of floating mid-line, and the currency never shrinks — the
/// truncation the ~76pt track forces eats the amount's tail first, because the
/// unit must never be the thing that gets clipped.
struct TilePrice: View {
    let price: String?
    /// The figure is a MODEL ESTIMATE, not a traded price (option tiles only).
    var estimate = false
    /// The figure is a CACHED fallback, not a live price — muted amount in the
    /// same slot. Colour is reinforcement only; the disclosure is the
    /// "cached · HH:mm" text the tile renders in its session-line slot.
    var muted = false

    var body: some View {
        // '—' has no currency to split off and comes back whole, so the nil
        // case and the unpriced case take the same path.
        let split = splitMoney(price ?? "—")

        HStack(alignment: .firstTextBaseline, spacing: 2) {
            if estimate {
                // A LEADING '≈', not a trailing "est." chip. The track is
                // ~72pt on a 375pt phone and only the amount may truncate, so
                // a third sibling would push the price itself into an
                // ellipsis — worse than showing no marker at all. '≈' reads
                // as "approximately" without translation.
                Text("≈")
                    .font(.system(size: 10))
                    .foregroundStyle(Color(Tokens.textMuted))
                    .accessibilityLabel("estimated price")
            }

            Text(split.amount)
                .font(.caption)
                .monospacedDigit()
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(Color(muted ? Tokens.textMuted : Tokens.textPrimary))

            if !split.currency.isEmpty {
                Text(split.currency)
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .layoutPriority(1)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
    }
}

/// One Dashboard tile: logo, ticker, price, and TWO percent lines — how the
/// stock is moving now, and how the position is doing overall. The Swift half
/// of `src/components/dashboard/ticker-tile.tsx`.
///
/// Everything rendered here is a pre-formatted display string from the
/// `LivePayload`; nothing is parsed back or re-derived. The `extended` figure
/// in particular is server-derived and rendered as-is.
///
/// The FIRST line is unrealized P/L against cost basis, always labelled `P/L`:
/// how the holding is doing OVERALL is what a dashboard is asked most often,
/// and today's move reads as a modifier of it. The label is not decoration —
/// two bare signed percentages stacked in a 76pt tile are ambiguous, and these
/// two answer genuinely different questions.
///
/// The SECOND line swaps between the day figure and the labelled extended one
/// (`ExtendedMoveView`, compact). Both-absent renders a muted '—' so the slot
/// height is fixed and a live update causes zero layout shift.
struct TickerTile: View {
    let symbol: String
    let displayName: String
    let price: String?
    let cachedPrice: CachedPrice?
    let dayPct: LiveFigure?
    let extended: ExtendedFigure?
    /// Absent for a stock with no position: the watchlist renders the same
    /// tile, and "P/L —" on something you do not own is noise, not
    /// information.
    let unrealizedPct: String?
    let direction: Direction
    /// The last five COMPLETED sessions, oldest first. Nil on a stock with no
    /// stored history — the strip reserves its space and draws nothing.
    ///
    /// Today's session is deliberately not among them: it already has its own
    /// line above and it is already live, and a sixth mark growing and
    /// shrinking through the day would be a second live element in a 76pt
    /// tile, repainting the strip at tick cadence to say what the line above
    /// it says in words.
    var trend: [TrendDay?]?
    /// The target-proximity readout, watchlist tiles only. Defaults to nil so
    /// every Dashboard call site compiles and renders byte-identically — the
    /// marker shares the first-line slot the watchlist leaves empty
    /// (`unrealizedPct` is nil there, and only there).
    var target: TargetStatus?

    var body: some View {
        // Cached is the fallback for the price slot only when there is no
        // live price at all — the same precedence the holding card applies.
        let cached = price == nil ? cachedPrice : nil
        let marker = TargetLineModel.from(target)

        TileFrame {
            TickerLogo(symbol: symbol, size: 32, monogramChars: 3)

            Text(symbol)
                .font(.system(.caption, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(Color(Tokens.textPrimary))

            TilePrice(price: cached?.text ?? price, muted: cached != nil)

            if let unrealizedPct {
                HStack(spacing: 3) {
                    Text("P/L")
                        .foregroundStyle(Color(Tokens.textMuted))
                    Text(unrealizedPct)
                        .monospacedDigit()
                        .foregroundStyle(Color(direction.token))
                }
                .font(.system(size: 11))
                .lineLimit(1)
            } else if let marker {
                // The watchlist's target marker, in the slot the P/L line
                // leaves empty there. Glyphs AND the percent — and the full
                // sentence in the tile's spoken label below — so the state is
                // never carried by the accent color alone.
                HStack(spacing: 3) {
                    Image(systemName: marker.glyph)
                        .font(.system(size: 9, weight: .semibold))
                    if let arrow = marker.arrow {
                        Image(systemName: arrow)
                            .font(.system(size: 9, weight: .semibold))
                    }
                    Text(marker.text)
                        .monospacedDigit()
                }
                .font(.system(size: 11))
                .lineLimit(1)
                .foregroundStyle(Color(marker.isNear ? Tokens.accent : Tokens.textMuted))
            }

            sessionLine(cached: cached)

            TrendLights(days: trend)
        }
        // One element, not six: a tile is a single thing to a screen reader,
        // and the figures repaint every second — a name that carried them
        // would re-announce itself constantly. The numbers stay in the tree
        // to be read on demand. The target SENTENCE joins the label because
        // the marker's meaning must survive without its glyphs or color.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(symbol), \(displayName)"
                + (marker.map { ", \($0.accessibilityLabel)" } ?? "")
                + TrendLights.phrase(for: trend)
        )
    }

    @ViewBuilder
    private func sessionLine(cached: CachedPrice?) -> some View {
        if let cached {
            // The day-change slot is empty in exactly this state (no live
            // quote → no day pair), so it carries the disclosure instead:
            // text, never colour alone.
            CachedAsOfLabel(asOfMs: cached.asOfMs)
                .lineLimit(1)
        } else if let extended {
            ExtendedMoveView(extended: extended, variant: .compact)
        } else {
            Text(dayPct?.text ?? "—")
                .font(.system(size: 11))
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(Color(dayPct.map { $0.direction.token } ?? Tokens.textMuted))
        }
    }
}

/// The tile marker's whole rendering decision, UI-free so the test target
/// exercises it without mounting SwiftUI — the `PriceTargetRowModel`
/// precedent. Everything displayed is the SERVER's string (`text`, and the
/// full `sentence` as the spoken label); the only decisions made here are
/// which glyphs to draw and whether the accent token applies.
struct TargetLineModel: Equatable {
    /// `target` for a waiting line, `checkmark` for the hit-only note.
    let glyph: String
    /// Which way the PRICE would have to move to reach the line: side
    /// `below` (price under the line) ⇒ `arrow.up.right` — the price must
    /// RISE. Nil when there is no direction to point (at the line, unpriced,
    /// or hit-only).
    let arrow: String?
    /// The server's compact readout: "3,21%", "Hit", or "—".
    let text: String
    /// Within 5% ⇒ the accent token; otherwise muted. A Bool rather than a
    /// color so the model stays Foundation-pure; the view maps it to
    /// `Tokens.accent` / `Tokens.textMuted`.
    let isNear: Bool
    /// The server's full sentence — words, never a glyph or a color alone.
    let accessibilityLabel: String

    static func from(_ status: TargetStatus?) -> TargetLineModel? {
        guard let status else { return nil }
        let arrow: String?
        switch status.side {
        case .below: arrow = "arrow.up.right"
        case .above: arrow = "arrow.down.right"
        case nil: arrow = nil
        }
        return TargetLineModel(
            glyph: status.hitOnly ? "checkmark" : "target",
            arrow: arrow,
            text: status.text,
            isNear: status.near,
            accessibilityLabel: status.sentence
        )
    }
}
