import SwiftUI

/// How far each holding has drifted from its target, and what it would take
/// to land back on it.
///
/// Every figure here is a server string folded from the SAME priced holdings
/// the breakdown above it renders, so the card and the slices can never
/// disagree. The phone does NO arithmetic in this file — no share, no
/// difference, no amount — which is why nothing here is ever converted to a
/// Double, and why `action` arrives as a word rather than as a minus sign the
/// renderer would have to read out of money.
///
/// Three states, and each says something different:
///
///  - the All scope: one line asking for a portfolio, and no Edit button —
///    targets are strictly per portfolio and there is nothing here to edit;
///  - a selected portfolio with nothing held and nothing targeted
///    (`drift == nil`): nothing at all, because the "Nothing priced in this
///    scope." line above already covers it;
///  - a selected portfolio with rows: the table, plus the sum note when the
///    targets do not add up to 100.
struct TargetDriftBlock: View {
    let drift: AnalyticsTargetDrift?
    /// True when the "All" chip is selected. A flag rather than an inference
    /// from `drift == nil`, because null also means "this portfolio holds and
    /// targets nothing" and the two deserve different sentences.
    let isAllScope: Bool
    let onEdit: (() -> Void)?

    var body: some View {
        if isAllScope {
            VStack(alignment: .leading, spacing: 4) {
                header(showsEdit: false)
                Text("Pick a portfolio to see target drift.")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        } else if let drift {
            VStack(alignment: .leading, spacing: 4) {
                header(showsEdit: true)
                ForEach(drift.rows, id: \.instrumentId) { row in
                    self.row(row)
                }
                if let note = drift.sumNote {
                    Text(note)
                        .font(.caption2)
                        .foregroundStyle(Color(Tokens.textMuted))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Target drift")
        }
    }

    private func header(showsEdit: Bool) -> some View {
        HStack(spacing: 8) {
            Text("Target drift")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            Spacer(minLength: 8)
            if showsEdit, let onEdit {
                Button("Edit", action: onEdit)
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textSecondary))
                    // 44 pt is the tap target, not the drawn height — the
                    // label stays a caption beside the section title.
                    .frame(minWidth: 44, minHeight: 44, alignment: .trailing)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Edit target weights")
            }
        }
    }

    /// One holding's line. It WRAPS rather than truncates, because the widest
    /// case ("MSFT — target +33,33%, now +41,20% · +7,87 pp · Sell 1 234,56 zł")
    /// does not fit one line on the smallest iPhone and a truncated figure is
    /// worse than a second line.
    ///
    /// Text carries the whole meaning: the direction is the word "Buy" or
    /// "Sell", never a colour, and a holding with no target says so in words
    /// rather than showing a zero.
    private func row(_ row: AnalyticsTargetDriftRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(row.symbol)
                .font(.subheadline)
                .foregroundStyle(Color(Tokens.textPrimary))
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(row.target ?? "no target") → \(row.actual)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
                    .fixedSize(horizontal: false, vertical: true)
                if let secondary = secondaryLine(row) {
                    Text(secondary)
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textMuted))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(voiceOverLabel(row))
    }

    /// The drift and the order to place, when there is a target to be off.
    /// Pure string assembly over server strings — nothing is derived.
    private func secondaryLine(_ row: AnalyticsTargetDriftRow) -> String? {
        var parts: [String] = []
        if let drift = row.drift { parts.append(drift) }
        if let amount = row.amount, let action = row.action {
            parts.append("\(action == .buy ? "Buy" : "Sell") \(amount)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func voiceOverLabel(_ row: AnalyticsTargetDriftRow) -> String {
        let target = row.target.map { "target \($0)" } ?? "no target"
        return [row.symbol, target, "now \(row.actual)", secondaryLine(row)]
            .compactMap { $0 }
            .joined(separator: ", ")
    }
}
