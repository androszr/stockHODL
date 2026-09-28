import SwiftUI

/// Every word the extended-hours box says, decided without SwiftUI so the test
/// target pins it — the `TargetLineModel` precedent. The figures themselves
/// are the server's strings (`LiveExtendedSummary`); only the labels around
/// them, which depend on the session kind, are chosen here.
///
/// plans/2026-09-28-watchlist-grid-extended-hours.md: during pre-market and
/// after hours the Dashboard says what the whole book is doing at extended
/// prices, separately from the regular-session summary above it — which is
/// never folded into this figure, and this figure never into it.
struct ExtendedSummaryModel: Equatable {
    /// "Pre-market · holdings" / "After hours · holdings".
    let title: String
    /// The title row's leading session dot takes the accent token in
    /// pre-market and the secondary text token after hours (mockup part 2).
    /// A Bool so the model stays Foundation-pure; the view maps it. The dot
    /// is reinforcement only — the title says the session in words.
    let accentDot: Bool
    /// The muted trailing word on the title row — "live", but ONLY while the
    /// store's figures are fresh. A box painted from a persisted snapshot, or
    /// after the connection dropped, sits under a StaleBar saying the figures
    /// are old; "live" beside it would contradict the bar. Nil then.
    let liveWord: String?
    /// "At pre-market prices" / "At after-hours prices".
    let valueLabel: String
    /// "Priced pre-market" / "Priced after hours".
    let pricedLabel: String
    /// "6 of 8 holdings".
    let pricedText: String
    /// After hours only: the base of the figure, and that it is not in Today
    /// or Total P/L. Pre-market needs no such note — its base is the close
    /// the Today figure also starts from.
    let footnote: String?
    /// "NVDA +1,82%" per chip, in the server's order.
    let moverTexts: [String]
    /// The box's whole spoken reading.
    let spoken: String

    static let afterHoursFootnote =
        "Measured from today's 16:00 close. Not included in Today or Total P/L."

    /// `isFresh` is the Dashboard's own freshness notion — the one the
    /// StaleBar discloses: `!store.freshness.needsDisclosure`.
    static func from(_ s: LiveExtendedSummary, isFresh: Bool) -> ExtendedSummaryModel {
        let early = s.kind == .early
        let title = early ? "Pre-market · holdings" : "After hours · holdings"
        let valueLabel = early ? "At pre-market prices" : "At after-hours prices"
        let pricedLabel = early ? "Priced pre-market" : "Priced after hours"
        let pricedText = "\(s.pricedCount) of \(s.holdingsCount) holdings"
        let footnote: String? = early ? nil : afterHoursFootnote
        let moverTexts = s.movers.map { "\($0.symbol) \($0.pct.text)" }

        let liveWord: String? = isFresh ? "live" : nil
        var parts = [title]
        if let liveWord {
            parts.append(liveWord)
        }
        parts += [
            s.move.text,
            "\(valueLabel) \(s.valueAtExtended)",
            "\(pricedLabel) \(pricedText)",
        ]
        if !moverTexts.isEmpty {
            parts.append("Movers \(moverTexts.joined(separator: ", "))")
        }
        if let footnote {
            parts.append(footnote)
        }

        return ExtendedSummaryModel(
            title: title,
            accentDot: early,
            liveWord: liveWord,
            valueLabel: valueLabel,
            pricedLabel: pricedLabel,
            pricedText: pricedText,
            footnote: footnote,
            moverTexts: moverTexts,
            spoken: parts.joined(separator: ", ")
        )
    }
}

/// The temporary box under the Dashboard's `SummaryHeader`: session label,
/// the combined move leading, two labelled figures, up to three mover chips
/// and, after hours, the footnote. Present only while the server sends
/// `summary.extended`, which it does only during a live extended session.
struct ExtendedSummaryBox: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let extended: LiveExtendedSummary
    /// Whether the store's figures are current — gates the "live" word.
    let isFresh: Bool
    /// Switches to the Holdings tab. Nil draws the same box, untappable.
    var onTap: (() -> Void)?

    var body: some View {
        if let onTap {
            Button(action: onTap) { box }
                .buttonStyle(.plain)
                .accessibilityHint("Opens Holdings")
        } else {
            box
        }
    }

    private var box: some View {
        let model = ExtendedSummaryModel.from(extended, isFresh: isFresh)
        return QuietGroup {
            VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                VStack(alignment: .leading, spacing: 2) {
                    titleRow(model)
                    QuietFinancialValue(
                        text: extended.move.text,
                        prominent: true,
                        direction: extended.move.direction
                    )
                }

                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                        valueFigure(model)
                        pricedFigure(model)
                    }
                } else {
                    HStack(alignment: .top, spacing: QuietDesign.Space.section) {
                        valueFigure(model)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        pricedFigure(model)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if !extended.movers.isEmpty {
                    FlowRow(spacing: 6, lineSpacing: 6) {
                        ForEach(extended.movers, id: \.symbol) { mover in
                            chip(mover)
                        }
                    }
                }

                if let footnote = model.footnote {
                    Text(footnote)
                        .font(QuietDesign.TypeRole.metadata)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.spoken)
    }

    /// "● Pre-market · holdings … live": the session dot, the title, and the
    /// muted "live" pushed to the trailing edge. The dot is decoration beside
    /// words that already name the session, so it is hidden from VoiceOver
    /// (the whole box reads `model.spoken` anyway).
    private func titleRow(_ model: ExtendedSummaryModel) -> some View {
        HStack(alignment: .center, spacing: 6) {
            Circle()
                .fill(Color(model.accentDot ? Tokens.accent : Tokens.textSecondary))
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(model.title)
                .font(QuietDesign.TypeRole.supporting)
                .foregroundStyle(Color(Tokens.textMuted))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: QuietDesign.Space.xSmall)
            if let liveWord = model.liveWord {
                Text(liveWord)
                    .font(QuietDesign.TypeRole.metadata)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
    }

    private func valueFigure(_ model: ExtendedSummaryModel) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(model.valueLabel)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            QuietFinancialValue(text: extended.valueAtExtended)
        }
    }

    private func pricedFigure(_ model: ExtendedSummaryModel) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(model.pricedLabel)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            Text(model.pricedText)
                .font(QuietDesign.TypeRole.body)
                .monospacedDigit()
                .foregroundStyle(Color(Tokens.textPrimary))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "NVDA +1,82%": the ticker bold, the move in its direction's token —
    /// the sign carries the direction without the colour.
    private func chip(_ mover: LiveExtendedMover) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(mover.symbol)
                .bold()
                .foregroundStyle(Color(Tokens.textPrimary))
            Text(mover.pct.text)
                .monospacedDigit()
                .foregroundStyle(Color(mover.pct.direction.token))
        }
        .font(QuietDesign.TypeRole.metadata)
        .lineLimit(1)
        .padding(.horizontal, QuietDesign.Space.small)
        .padding(.vertical, QuietDesign.Space.xSmall)
        .background(Color(Tokens.surface2), in: Capsule())
    }
}
