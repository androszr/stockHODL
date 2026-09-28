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
        // Quiet Precision's grouping, scaled down to a grid cell: an opaque
        // surface and a soft radius, no outline. `maxHeight: .infinity` lets
        // every tile in a grid row take the tallest one's height, so a tile
        // missing a line never leaves a ragged row.
        VStack(spacing: QuietDesign.Space.xSmall) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, QuietDesign.Space.xSmall + 2)
        .padding(.vertical, QuietDesign.Space.medium)
        .background(
            Color(Tokens.surface1),
            in: RoundedRectangle(cornerRadius: QuietDesign.Radius.tile)
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
                Text("≈")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
            // One line, always: a price that wraps inside a grid cell makes
            // its row taller than its neighbours for no gain. The amount may
            // shrink a step before anything is cut; the unit never shrinks.
            Text(split.amount)
                .font(QuietDesign.TypeRole.tileFigure)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .foregroundStyle(Color(muted ? Tokens.textMuted : Tokens.textPrimary))
            if !split.currency.isEmpty {
                Text(split.currency)
                    .font(.caption2)
                    .lineLimit(1)
                    .layoutPriority(1)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel((estimate ? "Estimated price " : "Price ") + (price ?? "—"))
    }
}

/// The one column template every tile grid uses — the Dashboard's holdings
/// and options grids and the Watchlist's sections. `.adaptive` packs as many
/// columns as fit (four on every supported iPhone at default text size), so a
/// whole book reads in one glance; accessibility text sizes widen the column
/// minimum rather than squeezing large type into a 76 pt cell. One definition
/// so the two screens that show the same tickers cannot drift apart
/// (plans/2026-09-28-watchlist-grid-extended-hours.md).
enum TileGrid {
    static func columns(isAccessibilitySize: Bool) -> [GridItem] {
        let minimum: CGFloat = isAccessibilitySize ? 150 : 76
        return [GridItem(.adaptive(minimum: minimum), spacing: QuietDesign.Space.small, alignment: .top)]
    }
}

/// The grid cell the Dashboard and the Watchlist share: logo, ticker, price,
/// `P/L` against cost (or, on the Watchlist, the compact target line), the
/// session's move, and the five-session lights — the dense tile the grid was
/// read at a glance with, drawn in Quiet Precision's surface and type.
///
/// The Watchlist went back to this tile on 2026-09-28; the full-width
/// `TickerTile` row below survives only in the design catalog. Every figure
/// is the server's pre-formatted string.
struct TickerGridTile: View {
    let symbol: String
    let displayName: String
    let price: String?
    let cachedPrice: CachedPrice?
    let dayPct: LiveFigure?
    let extended: ExtendedFigure?
    let unrealizedPct: String?
    let direction: Direction
    var trend: [TrendDay?]?
    /// The target-proximity readout, Watchlist tiles only. Defaults to nil so
    /// every Dashboard call site compiles and renders byte-identically — the
    /// marker takes the `P/L` slot, which is empty exactly when nothing is
    /// owned (`unrealizedPct == nil`).
    var target: TargetStatus? = nil

    var body: some View {
        let cached = price == nil ? cachedPrice : nil
        let marker = unrealizedPct == nil ? TargetLineModel.from(target) : nil
        return TileFrame {
            TickerLogo(symbol: symbol, size: 32, monogramChars: 3)

            Text(symbol)
                .font(QuietDesign.TypeRole.tileTitle)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textPrimary))

            TilePrice(price: cached?.text ?? price, muted: cached != nil)

            if let unrealizedPct {
                TileFigureLine(label: "P/L", value: unrealizedPct, direction: direction)
            } else if let marker {
                targetLine(marker)
            }

            sessionLine(cached: cached)

            Spacer(minLength: 0)
            TrendLights(days: trend)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spokenLabel(cached: cached, marker: marker))
    }

    /// The tile's one spoken sentence, assembled step by step rather than as
    /// one long `+` chain of optional maps, which is the shape that trips the
    /// type-checker's complexity limit. Every piece after the first already
    /// carries its own leading ", " (or is empty), so they join with nothing.
    private func spokenLabel(cached: CachedPrice?, marker: TargetLineModel?) -> String {
        var parts: [String] = ["\(symbol), \(displayName), price \(cached?.text ?? price ?? "—")"]
        if let unrealizedPct {
            parts.append(", total P/L \(unrealizedPct)")
        }
        if let marker {
            parts.append(", \(marker.accessibilityLabel)")
        }
        parts.append(TickerTile.spokenSession(cached: cached, extended: extended, dayPct: dayPct))
        parts.append(TrendLights.phrase(for: trend))
        return parts.joined()
    }

    /// "◎ ↓26,02% to 110" — glyph, arrow, the server's distance and, when the
    /// track has room, the short target price. `ViewThatFits` drops the
    /// suffix before anything else is cut, because the distance is the figure
    /// the tile exists to show.
    private func targetLine(_ marker: TargetLineModel) -> some View {
        HStack(spacing: 2) {
            Image(systemName: marker.glyph)
            if let arrow = marker.arrow {
                Image(systemName: arrow)
            }
            ViewThatFits(in: .horizontal) {
                Text(marker.text + (marker.suffix ?? ""))
                Text(marker.text)
            }
        }
        .font(.caption2)
        .monospacedDigit()
        .lineLimit(1)
        .foregroundStyle(Color(marker.isNear ? Tokens.accent : Tokens.textSecondary))
    }

    @ViewBuilder
    private func sessionLine(cached: CachedPrice?) -> some View {
        if let cached {
            CachedAsOfLabel(asOfMs: cached.asOfMs)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        } else if let extended {
            ExtendedMoveView(extended: extended, variant: .compact)
        } else {
            TileFigureLine(label: "Day", value: dayPct?.text ?? "—", direction: dayPct?.direction)
        }
    }
}

/// A tile's labelled percent — `P/L +15,22%`, `Day −0,22%`. The word keeps
/// two stacked signed figures from reading as one, and the sign carries
/// direction without the colour.
struct TileFigureLine: View {
    let label: String
    let value: String
    var direction: Direction?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
            Text(value)
                .font(QuietDesign.TypeRole.tileFigure)
                .monospacedDigit()
                .foregroundStyle(Color(direction?.token ?? Tokens.textMuted))
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

/// The full-width row tile: logo, ticker, price, and TWO percent lines — how
/// the stock is moving now, and how the position is doing overall. No screen
/// renders it since the Watchlist returned to `TickerGridTile` (2026-09-28);
/// it stays for the design catalog until a follow-up retires it.
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
        let cached = price == nil ? cachedPrice : nil
        let marker = TargetLineModel.from(target)
        return QuietGroup {
            VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                        identity
                        priceValue(cached: cached)
                    }
                } else {
                    HStack(alignment: .top, spacing: QuietDesign.Space.medium) {
                        identity
                            .frame(maxWidth: .infinity, alignment: .leading)
                        priceValue(cached: cached)
                            .multilineTextAlignment(.trailing)
                            .layoutPriority(1)
                    }
                }

                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                        if let unrealizedPct {
                            QuietLabeledFigure(label: "Total P/L", value: unrealizedPct, direction: direction)
                        }
                        if cached == nil, extended == nil {
                            QuietLabeledFigure(label: "Today", value: dayPct?.text ?? "—", direction: dayPct?.direction)
                        }
                    }
                } else {
                    HStack(alignment: .top, spacing: QuietDesign.Space.medium) {
                        if cached == nil, extended == nil {
                            inlineFigure(label: "Today", value: dayPct?.text ?? "—", direction: dayPct?.direction)
                        }
                        Spacer(minLength: 0)
                        if let unrealizedPct {
                            inlineFigure(label: "Total P/L", value: unrealizedPct, direction: direction)
                        }
                    }
                }

                if let marker {
                    Label(marker.accessibilityLabel, systemImage: marker.glyph)
                        .font(QuietDesign.TypeRole.metadata)
                        .foregroundStyle(Color(marker.isNear ? Tokens.accent : Tokens.textSecondary))
                        .fixedSize(horizontal: false, vertical: true)
                }

                sessionLine(cached: cached)

                // The same labelled strip as `OptionTile`; the spoken label
                // below reads it, so it must stay on screen too.
                if trend != nil {
                    Text("Last 5 sessions")
                        .font(QuietDesign.TypeRole.metadata)
                        .foregroundStyle(Color(Tokens.textMuted))
                    TrendLights(days: trend)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(symbol), \(displayName), price \(cached?.text ?? price ?? "—")"
            + (unrealizedPct.map { ", total P/L \($0)" } ?? "")
            + (marker.map { ", \($0.accessibilityLabel)" } ?? "")
            + Self.spokenSession(cached: cached, extended: extended, dayPct: dayPct)
            + TrendLights.phrase(for: trend))
    }

    private func inlineFigure(label: String, value: String, direction: Direction?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: QuietDesign.Space.xSmall) {
            Text(label).foregroundStyle(Color(Tokens.textMuted))
            Text(value)
                .monospacedDigit()
                .foregroundStyle(Color(direction?.token ?? Tokens.textMuted))
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(QuietDesign.TypeRole.metadata)
    }

    static func spokenSession(cached: CachedPrice?, extended: ExtendedFigure?, dayPct: LiveFigure?) -> String {
        if let cached {
            return ", cached at \(Instants.clock(cached.asOfMs))"
        }
        if let extended {
            let session = extended.kind == .early ? "pre-market" : "after hours"
            let closed = extended.live ? "" : ", closed session"
            let when = extended.endedAtMs.map { ", \(Instants.weekdayTime($0))" } ?? ""
            return ", \(session) \(extended.text)\(closed)\(when)"
        }
        return ", today \(dayPct?.text ?? "—")"
    }

    private var identity: some View {
        HStack(alignment: .top, spacing: QuietDesign.Space.medium) {
            TickerLogo(symbol: symbol, size: 40, monogramChars: 3)
            VStack(alignment: .leading, spacing: QuietDesign.Space.xSmall) {
                Text(symbol)
                    .font(.system(.body, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
                Text(displayName)
                    .font(QuietDesign.TypeRole.supporting)
                    .foregroundStyle(Color(Tokens.textSecondary))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func priceValue(cached: CachedPrice?) -> some View {
        QuietLabeledFigure(label: "Price", value: cached?.text ?? price ?? "—")
    }

    @ViewBuilder
    private func sessionLine(cached: CachedPrice?) -> some View {
        if let cached {
            CachedAsOfLabel(asOfMs: cached.asOfMs)
        } else if let extended {
            ExtendedMoveView(extended: extended, variant: .full)
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
    /// " to 110" — the grid tile's optional tail, from the server's short
    /// target price. Nil for hit-only and unpriced statuses, and for a
    /// payload from before the field existed.
    let suffix: String?

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
            accessibilityLabel: status.sentence,
            suffix: status.targetShort.map { " to \($0)" }
        )
    }
}
