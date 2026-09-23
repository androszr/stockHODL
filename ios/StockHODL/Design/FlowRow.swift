import SwiftUI

/// A row that wraps — what `flex-wrap` gives the web for free and SwiftUI has
/// no stock equivalent of.
///
/// It exists for the option card's headline row, where a price, an "estimate"
/// marker, a day figure, a basis clause and a last-trade caption sit on one
/// line when they fit and fall onto the next when they do not. An `HStack`
/// would compress every child toward illegibility instead, and a `VStack`
/// would stack five short fragments down the card.
///
/// Children are laid out at their ideal size and aligned on their FIRST
/// baseline within each line, so a caption sits on the price's baseline rather
/// than floating mid-line.
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let lines = layout(subviews: subviews, width: width)
        let height = lines.reduce(0) { $0 + $1.height } +
            lineSpacing * CGFloat(max(0, lines.count - 1))
        let widest = lines.map(\.width).max() ?? 0
        return CGSize(width: min(width, widest), height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var y = bounds.minY
        for line in layout(subviews: subviews, width: bounds.width) {
            var x = bounds.minX
            for index in line.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                // Baseline-aligned within the line: the tallest child sets the
                // baseline, and a small caption drops to sit on it.
                let baseline = subviews[index].dimensions(in: .unspecified)[.firstTextBaseline]
                subviews[index].place(
                    at: CGPoint(x: x, y: y + line.baseline - baseline),
                    proposal: ProposedViewSize(size)
                )
                x += size.width + spacing
            }
            y += line.height + lineSpacing
        }
    }

    private struct Line {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
        /// Distance from the line's top to its shared baseline.
        var baseline: CGFloat = 0
    }

    private func layout(subviews: Subviews, width: CGFloat) -> [Line] {
        var lines: [Line] = []
        var current = Line()

        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let baseline = subviews[index].dimensions(in: .unspecified)[.firstTextBaseline]
            let advance = current.indices.isEmpty ? size.width : size.width + spacing

            if !current.indices.isEmpty, current.width + advance > width {
                lines.append(current)
                current = Line()
            }

            current.indices.append(index)
            current.width += current.indices.count == 1 ? size.width : size.width + spacing
            current.baseline = max(current.baseline, baseline)
            current.height = max(current.height, size.height + max(0, current.baseline - baseline))
        }

        if !current.indices.isEmpty { lines.append(current) }
        return lines
    }
}
