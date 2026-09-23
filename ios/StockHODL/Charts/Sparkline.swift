import SwiftUI

/// The decorative day line on a market-strip tile.
///
/// Deliberately small in every sense: no axes, no ticks, no labels, no
/// scrubbing, no tooltip. It answers one question — which shape did today take
/// — and every FIGURE beside it (the level, the percent, the sign) is a
/// pre-formatted string from the server. Nothing here is ever read as a number.
///
/// Money discipline: the decimal strings become coordinates through
/// `PlotPoints.map` and through nothing else, so no float conversion happens
/// in this file at all and the sanctioned crossing stays one file wide (CI
/// greps for it). A value that will not parse is DROPPED there rather than
/// zeroed — the line simply gets shorter, because a fabricated zero would
/// draw a crash that never happened.
///
/// An empty or single-point series RESERVES the frame and draws nothing, the
/// `TrendLights` rule: a strip whose tiles changed height as data arrived
/// would make the row jump under a thumb.
struct Sparkline: View {
    /// Oldest first — the server's own regular-session bars.
    let points: [ChartPoint]
    /// Colour comes from the day figure's own direction, so the line and the
    /// percent beside it can never disagree. Never a ternary on a sign here.
    let direction: Direction

    var height: CGFloat = 24

    private static let strokeWidth: CGFloat = 1.5

    var body: some View {
        // Intraday granularity: X is the point INDEX, which is what a
        // categorical session line wants (a continuous axis would draw the
        // overnight gap as a long diagonal — a closed market rendered as data).
        let plotted = PlotPoints.map(points, granularity: .intraday)

        GeometryReader { geometry in
            Path { path in
                let coordinates = Sparkline.coordinates(plotted, in: geometry.size)
                guard let first = coordinates.first else { return }
                path.move(to: first)
                for point in coordinates.dropFirst() { path.addLine(to: point) }
            }
            .stroke(
                Color(direction.sparklineToken),
                style: StrokeStyle(lineWidth: Sparkline.strokeWidth, lineCap: .round, lineJoin: .round)
            )
        }
        .frame(height: height)
        // The tile speaks for itself in one combined sentence naming the
        // index, the fund, the level and the move. A second element here
        // would be a swipe stop that says nothing the sentence has not said.
        .accessibilityHidden(true)
    }

    /// Plotted geometry → points inside the frame.
    ///
    /// Fewer than two points draws nothing: a single mark is not a line, and
    /// stretching one observation across the width would suggest a flat
    /// session that was never observed. A genuinely flat session (no spread)
    /// draws down the middle.
    ///
    /// The vertical inset is half the stroke at each edge, so the extremes are
    /// drawn whole rather than clipped by the frame they touch.
    static func coordinates(_ plotted: [PlotPoint], in size: CGSize) -> [CGPoint] {
        guard plotted.count >= 2, size.width > 0, size.height > 0 else { return [] }

        let values = plotted.map(\.y)
        guard let low = values.min(), let high = values.max() else { return [] }
        let spread = high - low

        let inset = Sparkline.strokeWidth / 2
        let usableHeight = max(size.height - Sparkline.strokeWidth, 0)
        let lastIndex = CGFloat(plotted.count - 1)

        return plotted.enumerated().map { index, point in
            let x = size.width * CGFloat(index) / lastIndex
            // Geometry only — this fraction is never shown and never re-enters
            // any arithmetic a person reads.
            let fraction = spread > 0 ? (point.y - low) / spread : 0.5
            let y = inset + usableHeight * (1 - CGFloat(fraction))
            return CGPoint(x: x, y: y)
        }
    }
}
