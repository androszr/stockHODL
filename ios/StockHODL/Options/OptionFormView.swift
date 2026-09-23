import SwiftUI

/// Add a contract, or edit one purchase of it.
///
/// Fields validate on BLUR, not on every keystroke — "1" is not an invalid
/// price, it is a price on its way to "5,20", and a form that says otherwise
/// while you type is a form that trains you to ignore it. Same rule as the
/// transaction form.
///
/// In ADD mode the top half is the cascade, and each step is gated on the
/// previous one having an answer: a strike list has no meaning without an
/// expiry, and offering one would invite picking a contract that does not
/// exist. In EDIT mode the cascade is absent entirely — the contract is not
/// editable, and the form does not pretend otherwise by showing it disabled.
struct OptionFormView: View {
    @State var store: OptionFormStore
    /// The store that owns the list — the save writes through it so the list
    /// behind the sheet refreshes from one place.
    let optionsStore: OptionsStore
    /// Absent in previews and tests; the section simply does not render.
    var imports: ImportStore?

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: OptionFormStore.Field?

    private var isAdd: Bool {
        if case .add = store.mode { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            Form {
                // Adding only. An edit is about the LOT — the contract is
                // already bound and re-reading it from a picture could only
                // propose rebinding something the server refuses to rebind.
                if isAdd, let imports {
                    ScreenshotImportSection(
                        store: imports,
                        onPicked: { image in
                            guard let response = await imports.readOption(image) else { return }
                            await store.applyExtraction(response)
                        },
                        notes: store.importNotes
                    )
                }

                if isAdd { contractSection } else { contractSummary }
                lotSection
                if let message = store.errorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.loss))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(Tokens.surface0))
            .navigationTitle(isAdd ? "Add contract" : "Edit purchase")
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await store.save(into: optionsStore) } }
                        .disabled(store.isSaving)
                }
            }
            .onChange(of: store.didSave) { _, saved in
                if saved { dismiss() }
            }
            .onChange(of: focused) { previous, _ in
                // Validation happens when a field is LEFT.
                if let previous { store.markTouched(previous) }
            }
        }
    }

    // MARK: - The cascade

    private var contractSection: some View {
        Section("Contract") {
            HStack {
                Text("Stock")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textSecondary))
                Spacer()
                TextField("AAPL", text: $store.underlying)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($focused, equals: .contract)
            }

            if store.isLoadingExpirations {
                ProgressView().tint(Color(Tokens.textMuted))
            }

            if !store.expirations.isEmpty {
                Picker("Expiry", selection: $store.selectedExpiration) {
                    Text("Pick one").tag(String?.none)
                    ForEach(store.expirations, id: \.expirationDate) { expiry in
                        Text(expiry.label).tag(String?.some(expiry.expirationDate))
                    }
                }

                Picker("Type", selection: $store.contractType) {
                    Text("Call").tag("call")
                    Text("Put").tag("put")
                }
                .pickerStyle(.segmented)
            }

            if store.isLoadingStrikes {
                ProgressView().tint(Color(Tokens.textMuted))
            }

            if !store.strikes.isEmpty {
                Picker("Strike", selection: $store.selectedTicker) {
                    Text("Pick one").tag(String?.none)
                    ForEach(store.strikes, id: \.ticker) { contract in
                        Text(contract.strikeLabel).tag(String?.some(contract.ticker))
                    }
                }
            }

            if store.chainDegraded {
                // "The lookup is broken" and "there is nothing there" are
                // different answers, and only the first one is worth a note.
                Text("Contract lookup is unavailable right now — try again in a moment.")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            if !store.matchAlternatives.isEmpty {
                alternativesRow
            }

            if let issue = store.visibleIssue(.contract) {
                Text(issue)
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.loss))
            }
        }
    }

    /// No exact hit for what the screenshot read, but the vendor's own chain
    /// has close real contracts — the same near-miss list the web wizard
    /// offers. Tapping one adopts it exactly like a manual cascade pick.
    private var alternativesRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Closest real contracts")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(Tokens.textMuted))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(store.matchAlternatives, id: \.ticker) { contract in
                        Button {
                            Task { await store.adopt(contract) }
                        } label: {
                            Text("$\(contract.strikeLabel) · \(OptionFormView.expiryLabel(contract.expirationDate))")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    /// Edit mode: the contract is stated, not offered. Identity is refused by
    /// schema, so showing a disabled control would imply a possibility that
    /// does not exist.
    private var contractSummary: some View {
        Section("Contract") {
            Text("The contract itself cannot be changed — remove this purchase and add the right one instead.")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
        }
    }

    // MARK: - The lot

    private var lotSection: some View {
        Section("Purchase") {
            FormField(
                title: "Contracts",
                text: $store.quantity,
                field: .quantity,
                issue: store.visibleIssue(.quantity),
                focused: $focused,
                keyboard: .decimalPad
            )
            FormField(
                title: "Entry price (USD)",
                text: $store.entryPrice,
                field: .entryPrice,
                issue: store.visibleIssue(.entryPrice),
                focused: $focused,
                keyboard: .decimalPad
            )

            DatePicker(
                "Trade date",
                selection: Binding(
                    get: { OptionFormView.date(from: store.tradeDate) ?? Date() },
                    set: { store.tradeDate = OptionFormView.iso(from: $0) }
                ),
                displayedComponents: .date
            )

            FormField(
                title: "Costs (USD)",
                text: $store.fees,
                field: .fees,
                issue: store.visibleIssue(.fees),
                focused: $focused,
                keyboard: .decimalPad,
                placeholder: "0"
            )
        }
    }

    /// The date pickers speak `Date`, the wire speaks 'YYYY-MM-DD'. UTC on
    /// both sides so a late-evening tap does not file a trade for tomorrow.
    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static func date(from iso: String) -> Date? { isoFormatter.date(from: iso) }
    private static func iso(from date: Date) -> String { isoFormatter.string(from: date) }

    /// 'YYYY-MM-DD' → a short human label for the alternatives row, same
    /// idea as the web wizard's own `expiryLabel`.
    private static let expiryDisplayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "d MMM y"
        return formatter
    }()

    private static func expiryLabel(_ iso: String) -> String {
        guard let date = date(from: iso) else { return iso }
        return expiryDisplayFormatter.string(from: date)
    }
}
