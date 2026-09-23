import SwiftUI

/// One target row's whole rendering decision, kept UI-free so the test target
/// exercises it without mounting SwiftUI — the `WatchActionModel` precedent.
///
/// State is never carried by the picture alone: the direction is a glyph AND
/// lives in the accessibility label, and waiting-vs-hit is a sentence, never
/// a color. The price formats through `Money.swift` — never through a float,
/// which the CI grep enforces; a raw string that will not parse renders
/// verbatim rather than as a fabricated zero.
struct PriceTargetRowModel: Equatable {
    /// `arrow.up.right` / `arrow.down.right` — which way the line is crossed.
    let glyph: String
    let priceText: String
    /// "Waiting", or "Hit <day month hour:minute>" — the state in words.
    let stateText: String
    let isHit: Bool
    let accessibilityLabel: String

    static func from(_ target: PriceTarget, currency: String) -> PriceTargetRowModel {
        let priceText = dec(target.targetPrice)
            .map { fmtMoney($0, currency: currency) } ?? target.targetPrice
        let directionWord = target.direction == .up ? "above" : "below"
        let stateText = target.hitAtMs.map { "Hit \(PriceTargetRowModel.hitTime($0))" } ?? "Waiting"
        return PriceTargetRowModel(
            glyph: target.direction == .up ? "arrow.up.right" : "arrow.down.right",
            priceText: priceText,
            stateText: stateText,
            isHit: target.hitAtMs != nil,
            accessibilityLabel: "Target \(directionWord) at \(priceText), \(stateText)"
        )
    }

    /// The hit instant, device-local in the app's one locale — the
    /// `cachedTime` shape. `.minute(.twoDigits)` always: the bare minute
    /// field drops the leading zero and prints "10:0" beside money.
    static func hitTime(_ ms: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            .formatted(
                .dateTime.day().month(.abbreviated)
                    .hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
                    .locale(ChartLabels.locale)
            )
    }
}

/// The "Price targets" block on the instrument screen — one row per line the
/// user has drawn, a Set target button, and a 44pt remove control per row.
///
/// The caller decides visibility: the section shows when the stock is owned
/// or watched OR any target exists (a target on an unwatched stock must stay
/// deletable), while the Set target button needs owned-or-watched, matching
/// the server's 409.
struct PriceTargetsSection: View {
    let targets: [PriceTarget]
    /// The proximity readout above the rows — the SERVER's sentence, built
    /// from the same calculation the watchlist tiles use, so the two can
    /// never tell different stories. Nil when the stock has no lines.
    let status: TargetStatus?
    /// The instrument's currency — targets are priced in it.
    let currency: String
    /// Owned or watched: whether drawing a NEW line is allowed here.
    let canSetTarget: Bool
    /// Rows whose delete is in flight; their remove button disables.
    let deletingIds: Set<String>
    let onSetTarget: () -> Void
    let onDelete: (PriceTarget) -> Void

    var body: some View {
        Panel(title: "Price targets") {
            if let status {
                // The "within 5%" suffix is a WORD in the accent colour —
                // reinforcement, never colour alone; the sentence itself
                // already carries the distance.
                (Text(status.sentence)
                    + (status.near
                        ? Text(" — within 5%").foregroundColor(Color(Tokens.accent))
                        : Text("")))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textSecondary))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if targets.isEmpty {
                Text("Get a push when this stock reaches a price you set.")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            ForEach(targets, id: \.id) { target in
                row(target)
            }

            if canSetTarget {
                Button(action: onSetTarget) {
                    Label("Set target", systemImage: "plus")
                        .font(.subheadline)
                        .foregroundStyle(Color(Tokens.accent))
                        // The 44pt floor without a full-width slab of accent.
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func row(_ target: PriceTarget) -> some View {
        let model = PriceTargetRowModel.from(target, currency: currency)
        return HStack(alignment: .center, spacing: 10) {
            // Decorative for VoiceOver — the direction word is in the row's
            // spoken label below, so the glyph never carries it alone.
            Image(systemName: model.glyph)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(Tokens.accent))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(model.priceText)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
                // The state is a sentence, not a color: a hit row stays on
                // the page, muted, until the user deletes it.
                Text(model.stateText)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(Color(model.isHit ? Tokens.textMuted : Tokens.textSecondary))
            }
            // One spoken element for the facts; the delete button stays its
            // own, reachable element rather than being combined away.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(model.accessibilityLabel)

            Spacer(minLength: 8)

            Button {
                onDelete(target)
            } label: {
                Image(systemName: "trash")
                    .foregroundStyle(Color(Tokens.textMuted))
                    // 44pt tap-target floor, same as every icon control.
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(deletingIds.contains(target.id))
            .accessibilityLabel("Delete target at \(model.priceText)")
        }
    }
}
