import Foundation

/// Where the user's own trades sit on a plotted line — the whole of that
/// question, and nothing about how a mark is drawn.
///
/// Four chart surfaces need this (instrument price, portfolio value, the
/// options book and one contract) and each of them would otherwise work it out
/// for itself, which is three chances to get the day key wrong. So it is one
/// pure function over `Foundation` alone: no SwiftUI, no Charts, and — the
/// rule that matters — **no float crossing at all**. This file is deliberately
/// NOT on the `ios.yml` money allowlist; `PlotPoints.swift` is the one
/// crossing and it stays one file wide. Coordinates are read off
/// `PlotPoint.x`/`.y`, which are already geometry, and the only arithmetic
/// here is on `Decimal`.

/// One trade, as a chart needs it: the facts to place it and the words to say
/// about it. Everything displayable is pre-formatted by the caller, in the
/// surface's own vocabulary, so a marker's callout can never word a trade
/// differently from the row that trade already has elsewhere on the screen.
struct TradeMark: Identifiable, Sendable, Equatable {
    /// Transaction id, or option lot id.
    let id: String
    /// WHAT was traded, in the surface's own words — the ticker ("AAPL") for a
    /// share trade, the contract headline ("AAPL $220 CALL") for an option
    /// lot. A mark on a portfolio-wide line is otherwise a count of things
    /// bought with no way to tell which, and the Holdings and Options charts
    /// are exactly that kind of line.
    let label: String
    let side: TransactionSide
    /// 'YYYY-MM-DD', the server's own field — never a date this client derived.
    let tradeDate: String
    /// Decimal string, or nil when the surface has no comparable Y (an option
    /// lot's premium against a total-value line, a purchase against a
    /// portfolio total). Nil simply means "do not price-match this one".
    let unitPriceRaw: String?
    /// Pre-formatted display text, in the surface's own vocabulary — "12 @
    /// 231,10 USD" where the surface already words the pair as one string
    /// (the instrument screen's `TransactionLine.quantityAtPrice`), or the
    /// quantity alone where quantity and price arrive separately from the
    /// server (an option lot).
    let quantityText: String
    /// The unit price, when it is a SEPARATE string. `nil` means
    /// `quantityText` already contains it — see above — and the callout must
    /// not print it twice.
    let priceText: String?
    let dateText: String

    /// "12 @ 231,10 USD", however the two halves arrived.
    var quantityAtPrice: String {
        guard let priceText else { return quantityText }
        return "\(quantityText) @ \(priceText)"
    }
}

/// One drawn mark: a plotted position and every trade that landed on it.
///
/// Trades are grouped by POINT rather than drawn one each, because a day with
/// four purchases has one place on the line and four overlapping glyphs is a
/// smudge, not four facts.
struct PlacedTradeMark: Identifiable, Sendable, Equatable {
    /// The point's index, as a string — stable for the life of one plot.
    let id: String
    /// In plot order.
    let trades: [TradeMark]
    /// GEOMETRY, copied from the matched point. Never derived from a trade's
    /// price: that is what "the mark sits ON the line" means, and it keeps the
    /// trade price out of the float world entirely.
    let x: Double
    let y: Double
    let pointIndex: Int
}

/// The answer for one plot: what to draw, and how much could not be drawn.
struct TradeMarkerPlacement: Sendable, Equatable {
    let marks: [PlacedTradeMark]
    /// Trades inside the plotted span whose day has no reading at all — a
    /// holiday, a gap in the data, or a point `downsample` dropped. Counted
    /// rather than hidden: a missing mark must never be silent.
    let unplacedInWindow: Int

    static let empty = TradeMarkerPlacement(marks: [], unplacedInWindow: 0)
}

enum TradeMarkers {
    /// The calendar day a plotted point belongs to.
    ///
    /// Two answers, and picking the wrong one is the single likeliest way to
    /// get trade markers wrong — see `ChartLabels.utcDate(atEpochMs:)`.
    static func dayKey(ofPointAt t: Int, granularity: ChartRange.Granularity) -> String {
        switch granularity {
        case .intraday: NYCalendar.isoDate(atEpochMs: t)
        case .daily: ChartLabels.utcDate(atEpochMs: t)
        }
    }

    /// Place every trade on the line it belongs to.
    ///
    /// - `matchOnPrice` is true only where the plotted quantity and the trade's
    ///   unit price are the same kind of number — the instrument PRICE chart.
    ///   On a total-value or return line they are not comparable at all, and
    ///   the day's last point is the figure the day is remembered by.
    static func place(
        _ trades: [TradeMark],
        on plotted: [PlotPoint],
        granularity: ChartRange.Granularity,
        matchOnPrice: Bool
    ) -> TradeMarkerPlacement {
        guard let firstPoint = plotted.first, let lastPoint = plotted.last else {
            return .empty
        }

        // Built once, in plot order.
        var byDay: [String: [PlotPoint]] = [:]
        for point in plotted {
            byDay[dayKey(ofPointAt: point.t, granularity: granularity), default: []].append(point)
        }

        let firstDay = dayKey(ofPointAt: firstPoint.t, granularity: granularity)
        let lastDay = dayKey(ofPointAt: lastPoint.t, granularity: granularity)

        // Point index → the trades that landed on it, in plot order.
        var grouped: [Int: [TradeMark]] = [:]
        var pointsByIndex: [Int: PlotPoint] = [:]
        var unplaced = 0

        for trade in trades {
            guard let candidates = byDay[trade.tradeDate], !candidates.isEmpty else {
                // Inside the window with no reading is a hole worth naming.
                // Outside it is simply not this window's business.
                if trade.tradeDate > firstDay, trade.tradeDate < lastDay { unplaced += 1 }
                continue
            }

            let match = matchOnPrice
                ? nearestByPrice(to: trade.unitPriceRaw, among: candidates)
                : candidates[candidates.count - 1]

            grouped[match.index, default: []].append(trade)
            pointsByIndex[match.index] = match
        }

        let marks = grouped.keys.sorted().compactMap { index -> PlacedTradeMark? in
            guard let point = pointsByIndex[index], let trades = grouped[index] else { return nil }
            return PlacedTradeMark(
                id: String(index),
                trades: trades,
                x: point.x,
                y: point.y,
                pointIndex: index
            )
        }

        return TradeMarkerPlacement(marks: marks, unplacedInWindow: unplaced)
    }

    /// The candidate whose own value is closest to what the user paid.
    ///
    /// `Decimal` throughout — the plotted floats are never subtracted here. A
    /// candidate whose `raw` will not parse is SKIPPED rather than read as
    /// zero, which would otherwise win every comparison by a mile. Scanning in
    /// plot order and replacing only on a strictly smaller distance makes the
    /// earliest moment win a tie by construction.
    private static func nearestByPrice(to raw: String?, among candidates: [PlotPoint]) -> PlotPoint {
        // No comparable price: the day's last point, exactly as if price
        // matching had not been asked for. Dropping the trade would be worse —
        // it happened.
        guard let raw, let price = dec(raw) else { return candidates[candidates.count - 1] }

        var best: PlotPoint?
        var bestDistance: Decimal?

        for candidate in candidates {
            guard let value = dec(candidate.raw) else { continue }
            let distance = (value - price).magnitude
            if bestDistance == nil || distance < bestDistance! {
                best = candidate
                bestDistance = distance
            }
        }

        return best ?? candidates[candidates.count - 1]
    }
}
