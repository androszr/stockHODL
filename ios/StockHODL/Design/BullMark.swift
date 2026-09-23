import SwiftUI

/// BullMark — the app's illustrated brand mark, from SharedAssets.
///
/// Decorative by construction — the accessible name lives on whatever wraps
/// it, never here.
struct BullMark: View {
    var body: some View {
        Image("BullMark")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .accessibilityHidden(true)
    }
}

#Preview {
    BullMark().frame(width: 60)
}
