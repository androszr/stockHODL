import SwiftUI

/// Stage C0's only screen, and deliberately not the beginning of the UI.
///
/// Its job is to make the two generated files provably real inside a running
/// app: the palette comes from `Tokens.swift` and the figures come from
/// `Money.swift`, so if either generator broke, this screen shows it at a
/// glance instead of the failure surfacing three stages later. The Holdings
/// screen arrives in C2 and replaces this wholesale.
struct ScaffoldView: View {
    /// A decimal string of the kind the API sends — never a literal number.
    private let sample = dec("23708.11") ?? .zero
    private let change = pctChange(from: dec("22500") ?? .zero, to: dec("23708.11") ?? .zero)

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()

            VStack(alignment: .leading, spacing: 24) {
                figures
                palette
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var figures: some View {
        VStack(alignment: .leading, spacing: 8) {
            let split = splitMoney(fmtMoney(sample, currency: "PLN"))

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(split.amount)
                    .font(.system(.largeTitle, design: .monospaced))
                    .foregroundStyle(Color(Tokens.textPrimary))
                Text(split.currency)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            Text(fmtPct(change))
                .font(.system(.headline, design: .monospaced))
                .foregroundStyle(Color(directionOf(change).token))
        }
    }

    private var palette: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tokens")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textSecondary))

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
                ForEach(Tokens.all, id: \.name) { entry in
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(entry.token))
                        .frame(height: 32)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
                        )
                }
            }
        }
    }
}

#Preview {
    ScaffoldView()
}
