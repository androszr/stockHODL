import SwiftUI

struct MoverBarItem: Identifiable {
    let id: String
    let label: String
    let contribution: String
    let direction: Direction
    let barShare: String
}

struct MoverBars: View {
    let items: [MoverBarItem]

    var body: some View {
        VStack(spacing: 10) {
            ForEach(items) { item in
                VStack(spacing: 4) {
                    HStack {
                        Text(item.label).font(.caption).lineLimit(1)
                        Spacer()
                        Text(item.contribution)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Color(item.direction.token))
                    }
                    GeometryReader { geometry in
                        Capsule()
                            .fill(Color(item.direction.token))
                            .frame(width: geometry.size.width * Self.fraction(item.barShare))
                    }
                    .frame(height: 5)
                    .background(Color(Tokens.surface2), in: Capsule())
                }
            }
        }
    }

    static func fraction(_ share: String) -> CGFloat {
        let point = ChartPoint(h: nil, l: nil, o: nil, p: nil, r: nil, t: 0, v: share)
        guard let y = PlotPoints.map([point], granularity: .daily, mode: .value).first?.y else { return 0 }
        return min(max(CGFloat(y) / 100, 0), 1)
    }
}
