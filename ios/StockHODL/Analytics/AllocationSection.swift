import SwiftUI

/// Where the money sits, four ways.
///
/// All four folds already ride in the payload, so switching a tab costs
/// ZERO requests and zero recomputation — the same reason the web page
/// ships every dimension in one pass.
///
/// iOS is the mobile shell, so this is the stacked bar plus labelled rows
/// (`StackedBar` on the web). The ring is the desktop tree and does not
/// belong here. Colour is never the only carrier: every slice is named in
/// text with its amount and its share.
struct AllocationSection: View {
    let breakdown: AnalyticsBreakdown
    let excludedSymbols: [ExcludedSymbol]
    /// Largest position + HHI score, folded server-side from the SAME ticker
    /// slices rendered above it. Nil means nothing could be priced, and nil
    /// renders NOTHING — the "Nothing priced in this scope." line already
    /// covers that state, and a fabricated zero score would be a lie.
    let concentration: AnalyticsConcentration?
    /// Target versus actual for the selected portfolio, folded from the SAME
    /// priced holdings as the slices above. Nil on the All scope and nil when
    /// the scope holds and targets nothing — `TargetDriftBlock` tells the two
    /// apart from `isAllScope`, because they deserve different sentences.
    let targetDrift: AnalyticsTargetDrift?
    let isAllScope: Bool
    /// Opens the bulk-edit sheet. Owned by `AnalyticsView`, which holds the
    /// store and therefore the selected scope id the sheet needs.
    let onEditTargets: (() -> Void)?

    @State private var dimension: AllocationDimension = .ticker

    var body: some View {
        let slices = dimension.slices(in: breakdown)
        let unpriced = excludedSymbols
            .filter { $0.reason == .noLiveQuote }
            .map(\.symbol)

        VStack(alignment: .leading, spacing: 12) {
            Text("Where the money sits")
                .font(.system(.headline, weight: .semibold))
                .foregroundStyle(Color(Tokens.textPrimary))

            dimensionTabs

            if slices.isEmpty {
                Text("Nothing priced in this scope.")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textMuted))
            } else {
                AllocationBar(slices: slices)
                sliceRows(slices)
            }

            if let concentration {
                concentrationBlock(concentration)
            }

            // Directly under the concentration block, inside the same card:
            // both are statements about the shape of the money above them.
            TargetDriftBlock(
                drift: targetDrift,
                isAllScope: isAllScope,
                onEdit: onEditTargets
            )

            if !unpriced.isEmpty {
                Text("Left out of these percentages, because they could not be priced: \(unpriced.joined(separator: ", ")).")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Allocation")
    }

    private var dimensionTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AllocationDimension.allCases, id: \.self) { item in
                    let selected = item == dimension
                    Button {
                        dimension = item
                    } label: {
                        Text(item.label)
                            .font(.footnote)
                            .foregroundStyle(Color(selected ? Tokens.textPrimary : Tokens.textSecondary))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(
                                Capsule().fill(Color(selected ? Tokens.surface2 : Tokens.surface1))
                            )
                            .overlay(
                                Capsule().strokeBorder(
                                    Color(selected ? Tokens.borderStrong : Tokens.borderSubtle),
                                    lineWidth: 1
                                )
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Allocation dimension")
    }

    /// Every value here is a server string — the phone does NO arithmetic on
    /// them, and the caption is the one piece of static client copy (it is a
    /// sentence, not a figure). Text carries the whole meaning: no colour-only
    /// signal, no new colour, `Tokens` members only.
    private func concentrationBlock(_ concentration: AnalyticsConcentration) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("Largest position")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                Spacer(minLength: 8)
                Text("\(concentration.topSymbol) \(concentration.topShare)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
            }
            HStack(spacing: 8) {
                Text("Concentration")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                Spacer(minLength: 8)
                Text("\(concentration.score) / 100")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
            }
            Text("100 means one holding; 5 equal holdings would score 20.")
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func sliceRows(_ slices: [AllocationSlice]) -> some View {
        VStack(spacing: 0) {
            ForEach(slices, id: \.key) { slice in
                HStack(spacing: 10) {
                    Circle()
                        .fill(Color(AllocationToken.token(for: slice.colorVar)))
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(slice.label)
                        .font(.subheadline)
                        .foregroundStyle(Color(Tokens.textPrimary))
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(slice.value)
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(Color(Tokens.textPrimary))
                        Text(slice.pct)
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// The four dimensions `buildAllocation` folds in one pass. Labels match
/// `DIMENSION_LABEL` on the web so the two screens do not name the same
/// breakdown two different ways.
enum AllocationDimension: String, CaseIterable, Sendable {
    case ticker
    case portfolio
    case currency
    case sector

    var label: String {
        switch self {
        case .ticker: "Company"
        case .portfolio: "Portfolio"
        case .currency: "Currency"
        case .sector: "Industry"
        }
    }

    func slices(in breakdown: AnalyticsBreakdown) -> [AllocationSlice] {
        switch self {
        case .ticker: breakdown.ticker
        case .portfolio: breakdown.portfolio
        case .currency: breakdown.currency
        case .sector: breakdown.sector
        }
    }
}

/// `var(--color-cat-N)` on the wire → the generated token. The mapping is
/// the only hand-written link between the CSS variable the server sends and
/// the iOS palette, so a new category token has exactly one place to land.
enum AllocationToken {
    static func token(for colorVar: String) -> DesignToken {
        switch colorVar {
        case "var(--color-cat-1)": Tokens.cat1
        case "var(--color-cat-2)": Tokens.cat2
        case "var(--color-cat-3)": Tokens.cat3
        case "var(--color-cat-4)": Tokens.cat4
        case "var(--color-cat-5)": Tokens.cat5
        case "var(--color-cat-6)": Tokens.cat6
        case "var(--color-cat-7)": Tokens.cat7
        case "var(--color-cat-8)": Tokens.cat8
        case "var(--color-cat-unknown)": Tokens.catUnknown
        default: Tokens.catUnknown
        }
    }
}

/// The mobile shape: one proportional bar, labelled by the rows beneath it.
///
/// Widths come from `PlotPoints` — the one sanctioned string→float crossing —
/// over each slice's `share`. The visible figure beside the bar is still the
/// server-formatted `pct` string. An unparsable share draws nothing rather
/// than a fabricated zero, which would look like a real empty slice.
private struct AllocationBar: View {
    let slices: [AllocationSlice]

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(slices, id: \.key) { slice in
                    let plotted = PlotPoints.map(
                        [ChartPoint(h: nil, l: nil, o: nil, p: nil, r: nil, t: 0, v: slice.share)],
                        granularity: .daily
                    )
                    let fraction = plotted.first.map { CGFloat($0.y) / 100 } ?? 0
                    Color(AllocationToken.token(for: slice.colorVar))
                        .frame(width: geo.size.width * fraction)
                }
            }
        }
        .frame(height: 12)
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}
