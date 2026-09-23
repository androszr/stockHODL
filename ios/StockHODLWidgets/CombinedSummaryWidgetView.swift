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
struct CombinedSummaryWidgetView: View {
    let entry: SummaryEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .containerBackground(Color(Tokens.surface0), for: .widget)
    }

    private var content: some View {
        // `capturedAt` only exists for a CACHED payload; `entry.date` is when
        // this timeline entry was built either way — same fallback rule as
        // `SummaryWidgetView.figures(_:capturedAt:)`.
        let capturedAt: Date? = if case let .figures(_, at) = entry.outcome { at } else { nil }

        return VStack(alignment: .leading, spacing: 8) {
            header(asOf: capturedAt ?? entry.date)

            switch entry.outcome {
            case let .figures(payload, _):
                figures(payload)
            case .signedOut:
                message("Sign in to StockHODL")
            case .unavailable:
                message("No data yet")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    /// Mark, name, age — name and age on SEPARATE rows, not squeezed onto
    /// one: sharing a row left only a sliver for "StockHODL" next to the
    /// ticking age, so the name itself was the thing that truncated
    /// ("StockH…"). Two rows gives the name its own width and the age its
    /// own line underneath. Sized up from the original caption2/12pt mark —
    /// this tile's top row was otherwise the only unused space in the whole
    /// widget, so the header earns its keep instead of floating above it.
    private func header(asOf: Date) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image("BullMark")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 20, height: 20)
                Text("StockHODL")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
                    .lineLimit(1)
            }
            // Live-ticking, same trick as SummaryWidgetView — no new timeline
            // entry needed for the age to keep counting up.
            Text(asOf, style: .relative)
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
                .lineLimit(1)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func figures(_ payload: WidgetSummaryResponse) -> some View {
        let plot = payload.dayLines.map { lines in
            CombinedDayLine(lines: lines, live: payload.market.status == .marketStatusOpen)
        }

        if family == .systemSmall {
            section(.holdings, summary: payload.holdings)
            section(.options, summary: payload.options)
            if let plot {
                plot.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    section(.holdings, summary: payload.holdings)
                    section(.options, summary: payload.options)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let plot {
                    VStack(alignment: .leading, spacing: 4) {
                        plot.frame(maxWidth: .infinity, maxHeight: .infinity)
                        dayLineKey
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
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

    private func section(_ side: SummarySide, summary: LiveSummary) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(side.title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(Tokens.textMuted))

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(summary.totalValue ?? "—")
                    .font(.system(.footnote, design: .rounded).weight(.semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)

                Spacer(minLength: 2)

                change(summary.dayChangePct, direction: summary.dayChange?.direction)
            }

            // The second change line only fits alongside the first in the
            // wider family — `systemSmall` stays to one line per side so both
            // sections fit without truncating the values that matter more.
            if family != .systemSmall {
                change(summary.totalChangePct, direction: summary.totalChange?.direction, label: "Total")
            }
        }
    }

    private func change(_ percent: String?, direction: Direction?, label: String? = nil) -> some View {
        HStack(spacing: 3) {
            if let label {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
            Text(percent ?? "—")
                .font(.caption2.weight(.medium))
                .foregroundStyle(Color((direction ?? .neutral).token))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(Color(Tokens.textSecondary))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}
