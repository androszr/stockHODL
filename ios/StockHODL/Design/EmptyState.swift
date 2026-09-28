import SwiftUI

/// One voice for an empty screen: what is absent, why, and what can be done.
struct EmptyState: View {
    struct Action {
        let label: String
        let run: () -> Void
    }

    let title: String
    let explanation: String
    var action: Action? = nil
    var secondaryAction: Action? = nil
    var showsStill: Bool = true

    var body: some View {
        VStack(spacing: 8) {
            if showsStill {
                Image("BearStill")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 72)
                    .accessibilityHidden(true)
            }

            Text(title)
                .font(QuietDesign.TypeRole.section)
                .foregroundStyle(Color(Tokens.textPrimary))

            Text(explanation)
                .font(QuietDesign.TypeRole.supporting)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color(Tokens.textMuted))

            if let action {
                button(action)
            }
            if let secondaryAction {
                button(secondaryAction)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }

    private func button(_ action: Action) -> some View {
        Button(action.label, action: action.run)
            .font(QuietDesign.TypeRole.supporting)
            .foregroundStyle(Color(Tokens.accent))
            .quietHitRegion()
    }
}
