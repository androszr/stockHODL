import SwiftUI
import WidgetKit

/// The Home Screen tile: a value, today, and total. Yahoo's arrangement,
/// because it is the one people already read without instructions.
///
/// Every figure here is a STRING the server formatted — `totalValue` arrives
/// as "148 250,00 zł" and `dayChangePct` as "+0,84%", both from `money.ts` via
/// the same composition the web summary uses. Nothing is parsed, rounded or
/// re-formatted on the device: non-negotiable #1 says a price never becomes a
/// number here, and a widget that re-derived a percentage from a display
/// string would be the exact bug that rule exists to prevent.
struct SummaryWidgetView: View {
    let entry: SummaryEntry
    let side: SummarySide
    /// Explicit family for fixed-size synthetic renders outside WidgetKit.
    var previewFamily: WidgetFamily? = nil
    @Environment(\.widgetFamily) private var family

    private var displayFamily: WidgetFamily { previewFamily ?? family }

    var body: some View {
        if displayFamily == .accessoryRectangular {
            // Accessory families paint no background of their own, and a
            // widget that declares one anyway is refused a Lock Screen /
            // StandBy placement — same rule `LockScreenWidgetView` follows.
            accessoryContent
                .containerBackground(.clear, for: .widget)
        } else {
            content
                .containerBackground(Color(Tokens.surface0), for: .widget)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch entry.outcome {
        case let .figures(payload, capturedAt):
            figures(side.summary(of: payload), capturedAt: capturedAt)
        case .signedOut:
            // Tapping any widget opens the app, which is the only place a
            // passkey ceremony can run — so the message is an instruction the
            // user can actually follow, not an error code.
            message("Sign in to StockHODL")
        case .unavailable:
            message("No data yet")
        }
    }

    /// The Lock Screen shape: title, one big figure, one caption — the layout
    /// Apple's own Stocks widget uses for a watchlist total, and the one asked
    /// for here by name. `dayChangePct` carries its own sign from the server
    /// (non-negotiable #1 — nothing here re-derives it), so unlike the compact
    /// `row` this needs no separate arrow to read as a gain or a loss.
    @ViewBuilder
    private var accessoryContent: some View {
        switch entry.outcome {
        case let .figures(payload, _):
            let summary = side.summary(of: payload)
            // The Holdings side follows the extended session (percent and
            // caption); Options keeps its regular day figure.
            let extendedBadge = side == .holdings ? WidgetSessionPresentation.badge(summary) : nil
            VStack(alignment: .leading, spacing: 0) {
                Text(side.title)
                    .font(.caption2)
                Text(side == .holdings
                     ? WidgetSessionPresentation.holdingsPercent(summary)
                     : summary.dayChangePct ?? "—")
                    .font(.title2.weight(.semibold))
                    .minimumScaleFactor(0.8)
                    .lineLimit(1)
                    .widgetAccentable()
                Text(extendedBadge ?? "Today")
                    .font(.caption2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        case .signedOut:
            Text("\(side.title) — sign in")
        case .unavailable:
            Text("\(side.title) — no data")
        }
    }

    private func figures(_ summary: LiveSummary, capturedAt: Date?) -> some View {
        // `capturedAt` only exists for a CACHED payload (`WidgetDataSource`
        // leaves it nil on a fresh fetch); `entry.date` is when this timeline
        // entry was built either way, so it is the right fallback for "how
        // old is what's on screen" rather than leaving the fresh case mute.
        let asOf = capturedAt ?? entry.date

        // Holdings follows the extended session (value at extended prices,
        // the extended move as a row, a session badge); Options never does.
        let holdings = side == .holdings
        let badge = holdings ? WidgetSessionPresentation.badge(summary) : nil
        let value = holdings
            ? WidgetSessionPresentation.holdingsValue(summary)
            : summary.totalValue ?? "—"
        let rows: [WidgetFigureRow] = holdings
            ? WidgetSessionPresentation.singleHoldingsRows(summary, family: displayFamily)
            : [
                WidgetFigureRow(label: "Today",
                                text: WidgetSummaryDisplay.change(summary, total: false, family: displayFamily),
                                direction: summary.dayChange?.direction),
                WidgetFigureRow(label: "Total P/L",
                                text: WidgetSummaryDisplay.change(summary, total: true, family: displayFamily),
                                direction: summary.totalChange?.direction),
            ]

        return VStack(alignment: .leading, spacing: 2) {
            header(asOf: asOf)

            Text(side.title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(Tokens.textMuted))
                .padding(.top, displayFamily == .systemSmall ? 0 : 2)

            if let badge {
                Text(badge)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(Tokens.textSecondary))
            }

            WidgetFigureText(text: value, size: .single)
                .layoutPriority(1)

            ForEach(rows, id: \.label) { item in
                row(label: item.label, value: item.text, direction: item.direction)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func header(asOf: Date) -> some View {
        let identity = HStack(spacing: 4) {
            Image("WidgetMark")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 12, height: 12)
            Text("StockHODL")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(Tokens.textMuted))
        }
        // Relative Text keeps counting without asking the provider to reload.
        let freshness = (Text("Updated ") + Text(asOf, style: .relative))
            .font(.caption2)
            .foregroundStyle(Color(Tokens.textMuted))
        return Group {
            if displayFamily == .systemSmall {
                VStack(alignment: .leading, spacing: 0) {
                    identity
                    freshness
                }
            } else {
                HStack(spacing: 4) {
                    identity
                    Spacer(minLength: 2)
                    freshness
                }
            }
        }
    }

    private func row(label: String, value: String, direction: Direction?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
            Spacer(minLength: 2)
            Text(value)
                .font(displayFamily == .systemSmall ? .caption2.weight(.medium) : .caption.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(Color((direction ?? .neutral).token))
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }

    private func message(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(side.title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(Tokens.textMuted))
            Text(text)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textSecondary))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}
