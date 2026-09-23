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
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if family == .accessoryRectangular {
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
            VStack(alignment: .leading, spacing: 0) {
                Text(side.title)
                    .font(.caption2)
                Text(summary.dayChangePct ?? "—")
                    .font(.title2.weight(.semibold))
                    .minimumScaleFactor(0.8)
                    .lineLimit(1)
                    .widgetAccentable()
                Text("Today")
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

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Image("WidgetMark")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 12, height: 12)
                Text("StockHODL")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(Tokens.textMuted))
                Spacer(minLength: 2)
                // A live `Text(_:style:)` rather than a formatted string: this
                // one ticks on its own between reloads — the same trick the
                // Yahoo widget uses for its "as of" line — instead of freezing
                // at whatever age it had when the timeline last ran.
                Text(asOf, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
            }

            Text(side.title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(Tokens.textMuted))
                .padding(.top, 4)

            Text(summary.totalValue ?? "—")
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(Color(Tokens.textPrimary))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .padding(.top, 2)

            Spacer(minLength: 4)

            // Today first, total second — the order the app's summary uses,
            // and the order of how often either is looked at.
            row(label: "Today", figure: summary.dayChange, percent: summary.dayChangePct)
            row(label: "Total", figure: summary.totalChange, percent: summary.totalChangePct)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    /// One change line. `systemSmall` has room for a percentage and nothing
    /// else, so it shows the percentage; `systemMedium` has room for the amount
    /// the percentage describes, and showing a percent alone there would be
    /// hiding information the payload already carries.
    private func row(label: String, figure: LiveFigure?, percent: String?) -> some View {
        let text = family == .systemSmall ? percent : figure?.text
        return HStack(spacing: 6) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
            Spacer(minLength: 2)
            Text(text ?? "—")
                .font(.caption.weight(.medium))
                .foregroundStyle(Color((figure?.direction ?? .neutral).token))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
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
