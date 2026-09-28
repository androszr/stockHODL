import SwiftUI
import WidgetKit

/// Display-only widget roles. The server still owns every amount and percent.
enum WidgetFigureSize {
    case single
    case combined
    case combinedSmall

    var font: Font {
        switch self {
        case .single: .system(.title3, design: .rounded, weight: .semibold)
        case .combined: .system(.subheadline, design: .rounded, weight: .semibold)
        case .combinedSmall: .system(.footnote, design: .rounded, weight: .semibold)
        }
    }
}

struct WidgetFigureText: View {
    let text: String
    let size: WidgetFigureSize
    var direction: Direction?

    var body: some View {
        Text(text)
            .font(size.font)
            .monospacedDigit()
            .foregroundStyle(Color(direction?.token ?? Tokens.textPrimary))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(text)
    }
}

enum WidgetSummaryDisplay {
    /// The small family uses the server's compact percent; the medium family
    /// has room for the full server-formatted amount and percent.
    static func change(_ summary: LiveSummary, total: Bool, family: WidgetFamily) -> String {
        if total {
            return (family == .systemSmall ? summary.totalChangePct : summary.totalChange?.text) ?? "—"
        }
        return (family == .systemSmall ? summary.dayChangePct : summary.dayChange?.text) ?? "—"
    }

    /// The extended-hours twin of `change`: small prints the compact percent,
    /// larger families the full "+184,62 zł (+0,26%)".
    static func extendedChange(_ extended: LiveExtendedSummary, family: WidgetFamily) -> String {
        family == .systemSmall ? (extended.movePct ?? "—") : extended.move.text
    }
}
