import SwiftUI

/// The five-day trend strip along the bottom edge of a tile: one mark per
/// completed trading session, rising from a shared hairline for a gain and
/// falling for a loss.
///
/// **Colour carries direction; HEIGHT carries magnitude.** That split is the
/// whole design and it is worth stating where somebody will read it. Twenty
/// tiles times five colour-graded dots is a wall of colour in which nothing
/// stands out, and this tile already spends colour on two other figures — so
/// there is no shade, no opacity ramp, no recency fade and no per-level tint
/// anywhere below. Three inks, all at full strength. A later change that adds
/// a paler green is undoing this, not refining it.
///
/// Presentational only, in `Design/` for the reason `ExtendedMoveView` and
/// `BullMark` are: no data, no store, no loader. The grading already happened
/// on the server (`src/lib/trend/day-trend.ts`), against absolute percentage
/// thresholds identical for every instrument, so two tiles side by side are
/// comparable and this view re-derives nothing.
struct TrendLights: View {
    /// Oldest session first — the array index IS the column index, so nothing
    /// here reverses anything.
    ///
    /// An entry may be NIL, and a nil is not a flat day. A flat day happened
    /// and went nowhere; a nil is a session with no figure at all — a contract
    /// that did not trade, an evening no model mark could be produced for, or
    /// a pair whose two ends were different kinds of number. The two are drawn
    /// differently below, and collapsing them would have the tile assert that
    /// something sat still on a day it was never priced on.
    let days: [TrendDay?]?

    /// Always five slots, however many sessions arrived. A strip that narrowed
    /// with its data would make two tiles in one row different widths, and
    /// `LazyVGrid` would size the row to whichever happened to have history.
    nonisolated private static let slots = 5

    /// Total height, and the arithmetic that fills it: 5pt of headroom, the
    /// 1pt hairline, 5pt of footroom.
    nonisolated static let height: CGFloat = 11
    nonisolated private static let baseline: CGFloat = 1

    /// Level → bar height. DISCRETE on purpose: at 5pt of headroom a
    /// continuous scale is sub-pixel noise, and four steps are four things a
    /// person can actually name.
    nonisolated static func barHeight(for level: Int) -> CGFloat {
        switch level {
        case 1: return 1.5
        case 2: return 3
        case 3: return 5
        default: return 0
        }
    }

    var body: some View {
        // Absent entirely reserves the space and draws nothing. Reserved
        // rather than collapsed, because a mixed grid would otherwise have
        // ragged rows; blank rather than five grey dashes, because on the
        // first launch after this ships EVERY tile is in that state for one
        // refresh, and a grid of grey dashes is a worse first impression than
        // a grid with a little more air.
        HStack(spacing: 2) {
            ForEach(0..<Self.slots, id: \.self) { slot in
                column(for: day(at: slot))
            }
        }
        .frame(height: Self.height)
        // The strip says nothing on its own — the tile speaks for it, in one
        // sentence, via `phrase(for:)`. A per-bar element would be five more
        // swipe stops for a figure the tile has already summarised.
        .accessibilityHidden(true)
    }

    /// Right-aligned: the most recent session is always the rightmost mark, so
    /// a short strip is missing its OLDEST days rather than its newest.
    ///
    /// A strip is normally exactly `slots` long — the server sizes it to the
    /// CALENDAR and fills a session it has no figure for with a nil — so the
    /// alignment is a no-op in the ordinary case. It still matters at the very
    /// start of a calendar, where fewer than five completed sessions exist at
    /// all, and a strip that grew from the left would move the newest session
    /// under a different column every day.
    private func day(at slot: Int) -> TrendDay? {
        guard let days, !days.isEmpty else { return nil }
        let offset = Self.slots - days.count
        let index = slot - offset
        return days.indices.contains(index) ? days[index] : nil
    }

    @ViewBuilder
    private func column(for day: TrendDay?) -> some View {
        // The baseline is drawn PER COLUMN rather than as one rule across the
        // strip, so a flat day is the same kind of object as its neighbours
        // instead of a hole in a line.
        ZStack {
            if let day, day.level > 0, day.direction != .neutral {
                bar(for: day)
            } else {
                Rectangle()
                    .fill(Color(day == nil ? Tokens.borderSubtle : Tokens.neutral))
                    .frame(height: Self.baseline)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func bar(for day: TrendDay) -> some View {
        let height = Self.barHeight(for: day.level)
        let up = day.direction == .gain

        return VStack(spacing: 0) {
            // The bar grows out of the hairline in one direction and the
            // opposite half stays empty, which is what puts every column on
            // one register.
            Spacer(minLength: 0)
            if up {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color(Tokens.sparklineGain))
                    .frame(height: height)
            }
            Rectangle()
                .fill(Color(Tokens.borderSubtle))
                .frame(height: Self.baseline)
            if !up {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color(Tokens.sparklineLoss))
                    .frame(height: height)
            }
            Spacer(minLength: 0)
        }
    }
}

extension TrendLights {
    /// The strip as ONE clause, appended to the tile's own accessibility
    /// label.
    ///
    /// It is a string rather than a view modifier because `TickerTile` sets an
    /// explicit `.accessibilityLabel` over `children: .combine`, which
    /// overrides its children — a label on the strip itself would simply be
    /// dropped. Empty when there is nothing to say, so the tile's label is
    /// unchanged on a stock with no history.
    nonisolated static func phrase(for days: [TrendDay?]?) -> String {
        guard let days, !days.isEmpty else { return "" }
        // Nothing at all to say beats saying "no data" five times: a strip of
        // pure holes is the same fact as no strip, and the tile's label should
        // not grow a clause for it.
        guard days.contains(where: { $0 != nil }) else { return "" }

        let clauses = days.map { day -> String in
            guard let day else { return "no data" }
            // The word carries the sign, so the glyph would say it twice —
            // "up +1,20%" is how a screen reader reads a stutter.
            let magnitude = day.pct.trimmingCharacters(in: CharacterSet(charactersIn: "+-"))
            switch day.direction {
            case .gain: return "up \(magnitude)"
            case .loss: return "down \(magnitude)"
            case .neutral: return "flat"
            }
        }
        let noun = days.count == 1 ? "session" : "sessions"
        return ", last \(days.count) \(noun): \(clauses.joined(separator: ", "))"
    }
}
