import SwiftUI

/// Dual session path for the Combined tile: holdings solid, options dashed.
///
/// Colour is up/down while the regular cash session is live; otherwise both
/// strokes are the quiet grey. No fill — the wash-behind-numbers treatment
/// was rejected. The signed percents on the numbers already speak, so this
/// plot is decorative.
struct CombinedDayLine: View {
    let lines: WidgetDayLines
    let live: Bool

    var body: some View {
        GeometryReader { geometry in
            let mapped = WidgetPlotPoints.map(lines, in: geometry.size)
            if mapped.holdings.isEmpty && mapped.options.isEmpty {
                Color.clear
            } else {
                ZStack {
                    Path { path in
                        path.move(to: CGPoint(x: 0, y: mapped.zeroY))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: mapped.zeroY))
                    }
                    // Solid: a dashed 0% rule collides with the options stroke.
                    .stroke(
                        Color(Tokens.textMuted),
                        style: StrokeStyle(lineWidth: 1, lineCap: .round)
                    )

                    stroke(mapped.holdings, dashed: false)
                    stroke(mapped.options, dashed: true)
                }
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func stroke(_ points: [WidgetPlotPoints.Point], dashed: Bool) -> some View {
        let style = StrokeStyle(
            lineWidth: dashed ? 1.6 : 1.8,
            lineCap: .round,
            lineJoin: .round,
            dash: dashed ? [4, 3] : []
        )
        if live {
            ForEach(Array(runs(points).enumerated()), id: \.offset) { _, run in
                Path { path in
                    guard let first = run.points.first else { return }
                    path.move(to: first)
                    for point in run.points.dropFirst() { path.addLine(to: point) }
                }
                .stroke(color(for: run.sign), style: style)
            }
        } else {
            Path { path in
                guard let first = points.first else { return }
                path.move(to: CGPoint(x: first.x, y: first.y))
                for point in points.dropFirst() {
                    path.addLine(to: CGPoint(x: point.x, y: point.y))
                }
            }
            .stroke(Color(Tokens.textMuted), style: style)
        }
    }

    /// Live colour is `Direction.sparklineToken` (`Tokens.sparklineGain` /
    /// `Tokens.sparklineLoss`). Zero and a closed session stay muted.
    private func color(for sign: Int) -> Color {
        if sign > 0 { return Color(Tokens.sparklineGain) }
        if sign < 0 { return Color(Tokens.sparklineLoss) }
        return Color(Tokens.textMuted)
    }

    private struct Run {
        var sign: Int
        var points: [CGPoint]
    }

    private func runs(_ points: [WidgetPlotPoints.Point]) -> [Run] {
        guard points.count >= 2 else { return [] }
        var out: [Run] = []
        var current: Run?
        func start(_ sign: Int, _ point: CGPoint) { current = Run(sign: sign, points: [point]) }
        func add(_ point: CGPoint) { current?.points.append(point) }
        func end() {
            if let run = current, run.points.count >= 2 { out.append(run) }
            current = nil
        }

        for i in 0..<(points.count - 1) {
            let a = points[i]
            let b = points[i + 1]
            let sa = a.value > 0 ? 1 : a.value < 0 ? -1 : 0
            let sb = b.value > 0 ? 1 : b.value < 0 ? -1 : 0
            let pa = CGPoint(x: a.x, y: a.y)
            let pb = CGPoint(x: b.x, y: b.y)
            if sa == sb {
                if current == nil { start(sa, pa) }
                add(pb)
            } else {
                let split = a.value / (a.value - b.value)
                let along = CGFloat(split)
                let cross = CGPoint(
                    x: a.x + (b.x - a.x) * along,
                    y: a.y + (b.y - a.y) * along
                )
                if current == nil { start(sa, pa) }
                add(cross)
                end()
                start(sb, cross)
                add(pb)
            }
        }
        end()
        return out
    }
}
