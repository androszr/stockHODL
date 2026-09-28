import SwiftUI
import WidgetKit

/// One tile, both totals — Holdings above Options, each in its own currency.
///
/// Home Screen widgets get full colour (unlike the lock screen's vibrant
/// material), so this can lean on `Tokens.gain`/`Tokens.loss` the way
/// `SummaryWidgetView` does. What it borrows from `LockScreenWidgetView`
/// instead is the "never sum them" discipline: `holdings` is złoty and
/// `options` is USD-only over unexpired lots, so they are always two labelled
/// blocks, never one added figure.
///
/// The header — mark, name, ticking age — is the same one `SummaryWidgetView`
/// prints, and it is drawn in EVERY state rather than only alongside figures:
/// a tile that loses its identity the moment the data is missing is the one
/// case where the user most needs to know which app is asking them to sign in.
///
/// `systemSmall` has room for a title, a value and one change line per side;
/// `systemMedium` adds the second change line, matching how `SummaryWidgetView`
/// itself scales with `family`.
///
/// Both families carry the day's dual plot (`CombinedDayLine`: holdings solid,
/// options dashed) in whatever height the figures leave — small under the two
/// totals, medium under the sections with its Holdings / Options key (the
/// key yields first when the room is short). The figures always win: when
/// they need the room, the plot is dropped whole rather than a value
/// shortened (`CombinedPlotPlacement`, `ViewThatFits`).
/// The Quiet Precision refresh (2026-09-25) dropped the small tile's plot by
/// accident; plans/2026-09-25-combined-widget-day-line-restore.md put it back.
///
/// During pre-market and after hours (plans/2026-09-28-watchlist-grid-extended-hours.md)
/// the Holdings half shows the server's extended aggregate — "Pre"/"AH", the
/// value at extended prices, a session badge in the header — and the Options
/// half only relabels. Every decision lives in `WidgetSessionPresentation`.
struct CombinedSummaryWidgetView: View {
    let entry: SummaryEntry
    /// Explicit family for fixed-size synthetic renders outside WidgetKit.
    var previewFamily: WidgetFamily? = nil
    @Environment(\.widgetFamily) private var family

    private var displayFamily: WidgetFamily { previewFamily ?? family }

    var body: some View {
        content
            .containerBackground(Color(Tokens.surface0), for: .widget)
    }

    private var content: some View {
        // `capturedAt` only exists for a CACHED payload; `entry.date` is when
        // this timeline entry was built either way — same fallback rule as
        // `SummaryWidgetView.figures(_:capturedAt:)`.
        let capturedAt: Date? = if case let .figures(_, at) = entry.outcome { at } else { nil }

        return VStack(alignment: .leading, spacing: 4) {
            header(
                asOf: capturedAt ?? entry.date,
                style: WidgetSessionPresentation.headerFreshness(entry.outcome.payload?.holdings)
            )

            switch entry.outcome {
            case let .figures(payload, _):
                figures(payload)
            case .signedOut:
                message("Sign in to StockHODL")
            case .unavailable:
                message("No data yet")
            }
        }
        // Top-pinned: when the plot is dropped for long figures, the header
        // stays where it is on every other render instead of floating down.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Small uses two short rows; medium can place identity and age together.
    /// The age is a live relative Text, so it keeps counting between reloads.
    /// During an extended session the badge ("Pre-market") sits beside
    /// "Updated <age>" — never in place of the word, so a deferred reload's
    /// growing age cannot read as a session duration
    /// (`WidgetSessionPresentation.headerFreshness`). The small tile keeps the
    /// badge only when the pair fits its width.
    private func header(asOf: Date, style: WidgetHeaderFreshness) -> some View {
        let identity = HStack(spacing: 4) {
            Image("BullMark")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: displayFamily == .systemSmall ? 14 : 18,
                       height: displayFamily == .systemSmall ? 14 : 18)
            Text("StockHODL")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(Tokens.textPrimary))
        }
        let freshness = (Text("Updated ") + Text(asOf, style: .relative))
            .font(.caption2)
            .foregroundStyle(Color(Tokens.textMuted))
        return Group {
            if displayFamily == .systemSmall {
                VStack(alignment: .leading, spacing: 0) {
                    identity
                    switch style {
                    case let .badgeBesideUpdated(label):
                        // Badge + "Updated <age>" when the ~158 pt header
                        // has room; otherwise the plain freshness line.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 4) {
                                badgeText(label)
                                freshness
                            }
                            freshness
                        }
                    case .updated:
                        freshness
                    }
                }
            } else {
                HStack(spacing: 4) {
                    identity
                    Spacer(minLength: 2)
                    switch style {
                    case let .badgeBesideUpdated(label):
                        badgeText(label)
                    case .updated:
                        EmptyView()
                    }
                    freshness
                }
            }
        }
    }

    private func badgeText(_ label: String) -> some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Color(Tokens.textSecondary))
    }

    @ViewBuilder
    private func figures(_ payload: WidgetSummaryResponse) -> some View {
        let placement = CombinedPlotPlacement.for(
            family: displayFamily,
            hasLines: CombinedPlotPlacement.hasLines(payload.dayLines)
        )
        let plot = payload.dayLines.map { lines in
            CombinedDayLine(lines: lines, live: payload.market.status == .marketStatusOpen)
        }

        switch (placement, plot) {
        case let (.fillBelow, .some(plot)):
            // Plot variant first; the plot-less one when the totals need the
            // height. The plot's floor is what makes the first variant not fit.
            ViewThatFits(in: .vertical) {
                VStack(alignment: .leading, spacing: 4) {
                    smallSections(payload)
                    plot
                        .frame(maxWidth: .infinity, minHeight: 14, maxHeight: .infinity)
                        .layoutPriority(-1)
                }
                VStack(alignment: .leading, spacing: 4) {
                    smallSections(payload)
                }
            }
        case let (.fillBelowWithKey, .some(plot)):
            ViewThatFits(in: .vertical) {
                VStack(alignment: .leading, spacing: 4) {
                    mediumSections(payload)
                    plot
                        .frame(maxWidth: .infinity, minHeight: 18, maxHeight: .infinity)
                        .layoutPriority(-1)
                    dayLineKey
                }
                // Long figures: keep a 16 pt plot and give up the key first.
                VStack(alignment: .leading, spacing: 4) {
                    mediumSections(payload)
                    plot
                        .frame(maxWidth: .infinity, minHeight: 16, maxHeight: .infinity)
                        .layoutPriority(-1)
                }
                mediumSections(payload)
            }
        default:
            if displayFamily == .systemSmall {
                smallSections(payload)
            } else {
                mediumSections(payload)
            }
        }
    }

    @ViewBuilder
    private func smallSections(_ payload: WidgetSummaryResponse) -> some View {
        section(.holdings, summary: payload.holdings, market: payload.market)
            .layoutPriority(1)
        section(.options, summary: payload.options, market: payload.market)
            .layoutPriority(1)
    }

    private func mediumSections(_ payload: WidgetSummaryResponse) -> some View {
        HStack(alignment: .top, spacing: 8) {
            section(.holdings, summary: payload.holdings, market: payload.market)
            section(.options, summary: payload.options, market: payload.market)
        }
        .layoutPriority(1)
    }

    private var dayLineKey: some View {
        HStack(spacing: 10) {
            HStack(spacing: 4) {
                Capsule()
                    .fill(Color(Tokens.textMuted))
                    .frame(width: 12, height: 2)
                Text("Holdings")
            }
            HStack(spacing: 4) {
                Capsule()
                    .stroke(Color(Tokens.textMuted), style: StrokeStyle(lineWidth: 1.6, dash: [4, 3]))
                    .frame(width: 12, height: 2)
                Text("Options")
            }
        }
        .font(.caption2)
        .foregroundStyle(Color(Tokens.textMuted))
    }

    private func section(_ side: SummarySide, summary: LiveSummary, market: LiveMarket) -> some View {
        let holdings = side == .holdings
        let value = holdings
            ? WidgetSessionPresentation.holdingsValue(summary)
            : summary.totalValue ?? "—"
        return VStack(alignment: .leading, spacing: 1) {
            if displayFamily == .systemSmall {
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text(side.title)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color(Tokens.textMuted))
                    Spacer(minLength: 1)
                    Text(holdings
                         ? WidgetSessionPresentation.holdingsPercentLabel(summary)
                         : WidgetSessionPresentation.optionsDayLabel(market: market, family: displayFamily))
                        .font(.caption2)
                        .foregroundStyle(Color(Tokens.textMuted))
                    Text(holdings
                         ? WidgetSessionPresentation.holdingsPercent(summary)
                         : summary.dayChangePct ?? "—")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Color(((holdings
                            ? WidgetSessionPresentation.holdingsPercentDirection(summary)
                            : summary.dayChange?.direction) ?? .neutral).token))
                }
                .accessibilityElement(children: .combine)
                WidgetFigureText(text: value, size: .combinedSmall)
                    .layoutPriority(1)
            } else {
                Text(side.title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(Tokens.textMuted))
                WidgetFigureText(text: value, size: .combined)
                    .layoutPriority(1)
                if holdings {
                    ForEach(WidgetSessionPresentation.mediumHoldingsRows(summary), id: \.label) { row in
                        change(row.text, direction: row.direction, label: row.label)
                    }
                } else {
                    change(summary.dayChangePct, direction: summary.dayChange?.direction,
                           label: WidgetSessionPresentation.optionsDayLabel(market: market, family: displayFamily))
                    change(summary.totalChangePct, direction: summary.totalChange?.direction, label: "Total P/L")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private func change(_ percent: String?, direction: Direction?, label: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
            Spacer(minLength: 1)
            Text(percent ?? "—")
                .font(.caption2.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(Color((direction ?? .neutral).token))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(Color(Tokens.textSecondary))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// Where the combined tile's day plot goes, decided without drawing anything.
///
/// Small draws it under the two totals; medium under the sections, with the
/// Holdings / Options key. No lines to draw — no payload, or nothing that maps
/// to a point — means no plot, so no empty strip takes room from a figure.
enum CombinedPlotPlacement: Equatable {
    case none
    case fillBelow
    case fillBelowWithKey

    static func `for`(family: WidgetFamily, hasLines: Bool) -> CombinedPlotPlacement {
        guard hasLines else { return .none }
        switch family {
        case .systemSmall: return .fillBelow
        case .systemMedium, .systemLarge, .systemExtraLarge: return .fillBelowWithKey
        default: return .none
        }
    }

    /// True when at least one series maps to a point. The size is nominal —
    /// emptiness does not depend on it, only on the session span and values.
    static func hasLines(_ lines: WidgetDayLines?) -> Bool {
        guard let lines else { return false }
        let mapped = WidgetPlotPoints.map(lines, in: CGSize(width: 100, height: 100))
        return !(mapped.holdings.isEmpty && mapped.options.isEmpty)
    }
}
