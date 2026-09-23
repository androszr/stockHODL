import SwiftUI

/// The "Set target" sheet: one decimal price field, and the server's own
/// refusal sentence under it when the line cannot be drawn.
///
/// The field reuses `TransactionInput.swift`'s rules rather than restating
/// them — `normalizeDecimalSeparator` (the pl-PL keypad's comma as the
/// decimal point) and `decimalIssue` with the same `amount` bounds every
/// money input carries, thousands-grouping refusal included. The server still
/// validates everything; the local check only turns the field red without a
/// round trip. Direction is deliberately NOT chosen here: the server derives
/// it from the current price, and a picker would let the two disagree.
struct PriceTargetSheet: View {
    let store: InstrumentStore

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Field?
    @State private var price = ""
    @State private var issue: String?

    enum Field: Hashable {
        case price
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    FormField(
                        title: "Target price (\(store.currency))",
                        text: $price,
                        field: Field.price,
                        issue: issue,
                        focused: $focused,
                        keyboard: .decimalPad,
                        placeholder: "0,00"
                    )
                } footer: {
                    Text("You'll get a push when \(store.symbol) reaches this price — from above or below, whichever side it sits on now.")
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(Tokens.surface0))
            .navigationTitle("Set target")
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(store.isSavingTarget)
                }
            }
            .task { focused = .price }
        }
    }

    private func save() async {
        let normalized = normalizeDecimalSeparator(price)
        if let problem = decimalIssue(normalized, .amount) {
            issue = problem
            return
        }
        issue = nil
        // The store answers the sentence to show — the server's own words for
        // a refusal (409/400/503 via `ErrorBody`), or nil on success.
        if let refusal = await store.createTarget(price: normalized) {
            issue = refusal
        } else {
            dismiss()
        }
    }
}
