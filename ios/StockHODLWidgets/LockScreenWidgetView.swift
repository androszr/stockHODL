import SwiftUI
import WidgetKit

/// The lock screen: two labels, one percentage each, nothing else.
///
/// An accessory rectangle is two lines tall and tinted, and that shapes both
/// decisions here.
///
/// **No amounts.** A glance at a locked phone answers "up or down today", not
/// "how much do I own" — and the two totals are in different currencies
/// (`holdings` is złoty, `options` is USD-only over unexpired lots), so a pair
/// of figures stacked here invites a comparison that does not exist. The
/// labels and today's percentage are the whole payload.
///
/// **It renders monochrome.** Accessory widgets are drawn in the lock screen's
/// vibrant, single-tint material, so `Tokens.gain` and `Tokens.loss` — the
/// whole colour language the rest of the app leans on — simply do not survive
/// here. Direction has to be carried by a GLYPH instead, or a fall reads
/// exactly like a rise. That is what the arrow is for; it is not decoration.
struct LockScreenWidgetView: View {
    let entry: SummaryEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            // Accessory families paint no background of their own, but a widget
            // that declares none at all is refused a Lock Screen / StandBy
            // placement and says so only in a runtime log. `.clear` is the
            // declaration; it draws nothing.
            .containerBackground(.clear, for: .widget)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline: inline
        default: rectangular
        }
    }

    @ViewBuilder
    private var rectangular: some View {
        switch entry.outcome {
        case let .figures(payload, _):
            VStack(alignment: .leading, spacing: 3) {
                line(.holdings, summary: payload.holdings)
                line(.options, summary: payload.options)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        case .signedOut:
            Text("StockHODL — sign in")
        case .unavailable:
            Text("StockHODL — no data")
        }
    }

    /// Label left, today's move right — no amount between them. `Spacer`
    /// rather than a fixed column so the two rows agree on where the
    /// percentages sit whatever the label lengths are.
    private func line(_ side: SummarySide, summary: LiveSummary) -> some View {
        HStack(spacing: 4) {
            Text(side.title)
                // Bigger than the old three-column line could afford: dropping
                // the amounts frees the width, and a lock-screen glance is
                // read at arm's length.
                .font(.caption)
                .widgetAccentable()
            Spacer(minLength: 2)
            change(summary.dayChangePct, direction: summary.dayChange?.direction)
        }
    }

    /// Today's move, as an arrow plus a percentage. The arrow is the only thing
    /// distinguishing a gain from a loss once the tint has flattened the
    /// colour, so a figure with no direction gets no arrow rather than a
    /// misleading one.
    private func change(_ percent: String?, direction: Direction?) -> some View {
        HStack(spacing: 1) {
            switch direction {
            case .gain: Image(systemName: "arrowtriangle.up.fill").font(.system(size: 8))
            case .loss: Image(systemName: "arrowtriangle.down.fill").font(.system(size: 8))
            case .neutral, nil: EmptyView()
            }
            Text(percent ?? "—")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
    }

    /// One line above the clock, so it is holdings or nothing — there is no
    /// room for both here, and a truncated pair would be worse than an honest
    /// single figure. Today's percentage, matching the rectangle.
    @ViewBuilder
    private var inline: some View {
        switch entry.outcome {
        case let .figures(payload, _):
            // `Text` interpolation rather than a stack: the inline family
            // collapses any layout to a single string anyway.
            Text("Holdings \(payload.holdings.dayChangePct ?? "—")")
        case .signedOut:
            Text("StockHODL — sign in")
        case .unavailable:
            Text("StockHODL")
        }
    }
}
