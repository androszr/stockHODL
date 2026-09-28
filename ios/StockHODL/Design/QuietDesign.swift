import SwiftUI

/// Layout roles shared by the app's financial screens. Colors remain generated
/// from src/styles/tokens.css; these values describe layout, never data.
enum QuietDesign {
    enum Space {
        static let xSmall: CGFloat = 4
        static let small: CGFloat = 8
        static let medium: CGFloat = 12
        static let group: CGFloat = 16
        static let page: CGFloat = 20
        static let section: CGFloat = 24
        static let large: CGFloat = 32
    }

    enum Radius {
        static let control: CGFloat = 10
        static let group: CGFloat = 16
        static let tile: CGFloat = 12
    }

    enum TypeRole {
        static let screen = Font.system(.title, weight: .bold)
        static let headline = Font.system(.largeTitle, weight: .semibold)
        static let section = Font.system(.title3, weight: .semibold)
        static let body = Font.system(.body)
        static let supporting = Font.system(.subheadline)
        static let metadata = Font.system(.footnote)
        /// Grid tiles only: the dense cells the Dashboard is scanned by.
        static let tileTitle = Font.system(.subheadline, weight: .semibold)
        static let tileFigure = Font.system(.caption, weight: .medium)
    }
}

/// Opaque grouping without another outline around every piece of information.
struct QuietGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(QuietDesign.Space.group)
            .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: QuietDesign.Radius.group))
    }
}

struct QuietSectionHeading: View {
    let title: String

    var body: some View {
        Text(title)
            .font(QuietDesign.TypeRole.section)
            .foregroundStyle(Color(Tokens.textPrimary))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The same scalable, untruncated figure can lead a summary or a stock row.
/// Amounts and units are already formatted by the server.
struct QuietFinancialValue: View {
    let text: String
    var prominent = false
    var direction: Direction?

    var body: some View {
        Text(text)
            .font(prominent ? QuietDesign.TypeRole.headline : QuietDesign.TypeRole.body)
            .monospacedDigit()
            .foregroundStyle(Color(direction?.token ?? Tokens.textPrimary))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(text)
    }
}

/// A named secondary figure keeps a signed value's meaning independent of color.
struct QuietLabeledFigure: View {
    let label: String
    let value: String
    var direction: Direction?

    var body: some View {
        VStack(alignment: .leading, spacing: QuietDesign.Space.xSmall) {
            Text(label)
                .font(QuietDesign.TypeRole.metadata)
                .foregroundStyle(Color(Tokens.textMuted))
            QuietFinancialValue(text: value, direction: direction)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A button's visible shape may be smaller, but its hit region never is.
struct QuietHitRegion: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

extension View {
    func quietHitRegion() -> some View { modifier(QuietHitRegion()) }
}
