import SwiftUI

/// Add or edit one transaction.
///
/// Fields validate on BLUR, not on every keystroke: "1" is not an invalid
/// price, it is a price on its way to "182,40", and a form that says otherwise
/// while you type is a form that trains you to ignore it.
struct TransactionFormView: View {
    @State var store: TransactionFormStore
    /// Called after a successful save, so the list behind the sheet reloads.
    let onSaved: () -> Void
    /// Absent in previews and tests, and the section simply does not render —
    /// the form has never needed a network to be constructible and this must
    /// not be the thing that changes that.
    var imports: ImportStore?

    @Environment(\.dismiss) private var dismiss
    @State private var reachability = Reachability.shared
    @FocusState private var focused: TransactionDraft.Field?

    var body: some View {
        NavigationStack {
            Form {
                // Only when ADDING. Editing a saved transaction from a
                // picture would re-read fields the user has already corrected,
                // and the instrument is locked on edit anyway.
                if store.editing == nil, let imports {
                    ScreenshotImportSection(
                        store: imports,
                        onPicked: { image in
                            guard let prefill = await imports.readTransaction(image) else { return }
                            store.applyPrefill(prefill)
                        },
                        notes: store.importNotes.compactMap(PrefillNoteCopy.sentence(for:)),
                        readFields: store.importedFields
                    )
                }

                instrumentSection
                tradeSection
                if store.draft.needsFxRate { fxSection }
                noteSection
                if let message = store.errorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.loss))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(Tokens.surface0))
            .navigationTitle(store.editing == nil ? "Add transaction" : "Edit transaction")
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    // The label changes when a save died on the wire, so the
                    // control says what it is actually going to do. The draft
                    // is untouched — the sheet never dismissed — and the
                    // retry below fires by itself when the network returns.
                    Button(store.awaitingNetwork ? "Retry" : "Save") {
                        Task { await store.save() }
                    }
                    .disabled(!store.canSave)
                }
            }
            .task { await store.load() }
            // One retry, and only while the user is still looking at the
            // form — see `TransactionFormStore.connectivityChanged(to:)` for
            // why this is not a queue.
            .onChange(of: reachability.isConnected) { _, connected in
                store.connectivityChanged(to: connected)
            }
            .onChange(of: store.didSave) { _, saved in
                if saved {
                    onSaved()
                    dismiss()
                }
            }
            .onChange(of: focused) { previous, _ in
                // Validation happens when a field is LEFT.
                if let previous { store.markTouched(previous) }
            }
        }
    }

    // MARK: - Instrument

    @ViewBuilder
    private var instrumentSection: some View {
        Section("Instrument") {
            if store.editing == nil {
                SymbolSearchField(store: store, focused: $focused)
            } else {
                // Locked on edit: the server refuses a rebind, and offering
                // the field would promise something it will not do. Changing
                // the instrument means delete plus re-add.
                LabeledContent("Symbol", value: store.draft.symbol)
                Text("To change the instrument, delete this transaction and add it again.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            FormField(
                title: "Name",
                text: $store.draft.displayName,
                field: .displayName,
                issue: store.issue(for: .displayName),
                focused: $focused
            )
            FormField(
                title: "Exchange",
                text: $store.draft.exchange,
                field: .exchange,
                issue: store.issue(for: .exchange),
                focused: $focused
            )

            Picker("Currency", selection: $store.draft.currency) {
                // The closed list from `CURRENCIES`, not free text: a typo'd
                // code would bind the symbol permanently and NBP has no rate
                // for it.
                ForEach(Currency.allCases, id: \.self) { currency in
                    Text(currency.rawValue).tag(currency)
                }
            }
        }
    }

    // MARK: - Trade

    private var tradeSection: some View {
        Section("Trade") {
            Picker("Side", selection: $store.draft.side) {
                Text("Buy").tag(TransactionSide.buy)
                Text("Sell").tag(TransactionSide.sell)
            }
            .pickerStyle(.segmented)

            if store.portfolios.count > 1 {
                Picker("Portfolio", selection: $store.draft.portfolioId) {
                    Text("Pick one").tag("")
                    ForEach(store.portfolios.sorted { $0.sortOrder < $1.sortOrder }, id: \.id) {
                        Text($0.name).tag($0.id)
                    }
                }
            }

            FormField(
                title: "Quantity",
                text: $store.draft.quantity,
                field: .quantity,
                issue: store.issue(for: .quantity),
                focused: $focused,
                keyboard: .decimalPad
            )
            FormField(
                title: "Price",
                text: $store.draft.price,
                field: .price,
                issue: store.issue(for: .price),
                focused: $focused,
                keyboard: .decimalPad
            )
            FormField(
                title: "Fees",
                text: $store.draft.fees,
                field: .fees,
                issue: store.issue(for: .fees),
                focused: $focused,
                keyboard: .decimalPad,
                placeholder: "0"
            )
            FormField(
                title: "Trade date",
                text: $store.draft.tradeDate,
                field: .tradeDate,
                issue: store.issue(for: .tradeDate),
                focused: $focused,
                placeholder: "YYYY-MM-DD"
            )
        }
    }

    // MARK: - FX

    private var fxSection: some View {
        Section("FX rate to PLN") {
            FormField(
                title: "Rate",
                text: $store.draft.fxRateToBase,
                field: .fxRateToBase,
                issue: store.issue(for: .fxRateToBase),
                focused: $focused,
                keyboard: .decimalPad
            )

            HStack {
                if store.isFetchingFx {
                    ProgressView().controlSize(.small)
                }
                // Autofilled from the D-1 NBP mid rate and still overridable:
                // the server validates whatever ends up here like any typed
                // value, so an override is an answer rather than a bypass.
                Text(store.fxNote ?? "Auto-filled from the NBP rate for the day before the trade.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
    }

    private var noteSection: some View {
        Section("Note") {
            TextField("Optional", text: $store.draft.note, axis: .vertical)
                .lineLimit(1...4)
                .focused($focused, equals: .note)
        }
    }
}

// MARK: - Field

/// One labelled text field with its error underneath.
///
/// Extracted so the error placement, the focus binding and the autocorrect
/// settings are decided once. Eleven near-identical inline fields is how one
/// of them ends up autocapitalising a ticker.
///
/// Generic over the field enum rather than tied to `TransactionDraft.Field`:
/// the dividend form asks the same kind of question with its own field set,
/// and a second copy of this view is exactly how the two would drift.
struct FormField<Field: Hashable>: View {
    let title: String
    @Binding var text: String
    let field: Field
    let issue: String?
    @FocusState.Binding var focused: Field?
    var keyboard: UIKeyboardType = .default
    var placeholder: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textSecondary))
                Spacer()
                TextField(placeholder, text: $text)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .keyboardType(keyboard)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($focused, equals: field)
            }
            if let issue {
                Text(issue)
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.loss))
            }
        }
    }
}

// MARK: - Symbol search

/// The combobox. Type a ticker or a company name, pick a result, and three
/// fields fill at once.
struct SymbolSearchField: View {
    let store: TransactionFormStore
    @FocusState.Binding var focused: TransactionDraft.Field?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Symbol")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textSecondary))
                Spacer()
                TextField("AAPL", text: Binding(
                    get: { store.draft.symbol },
                    set: { value in
                        store.draft.symbol = value
                        store.search(value)
                    }
                ))
                .multilineTextAlignment(.trailing)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.characters)
                .focused($focused, equals: .symbol)

                if store.isSearching { ProgressView().controlSize(.small) }
            }

            if let issue = store.issue(for: .symbol) {
                Text(issue)
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.loss))
            }

            if store.searchDegraded {
                // Only when the vendor failed AND the local directory had
                // nothing. An ordinary empty result means "no such ticker",
                // which is a different sentence and gets none.
                Text("Search is unavailable — type the symbol, name and exchange yourself.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            ForEach(store.matches, id: \.symbol) { match in
                Button { store.choose(match) } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(match.symbol)
                                .font(.system(.caption, weight: .semibold))
                                .foregroundStyle(Color(Tokens.textPrimary))
                            Text(match.exchangeDisplay)
                                .font(.caption2)
                                .foregroundStyle(Color(Tokens.textMuted))
                        }
                        Text(match.name)
                            .font(.caption2)
                            .foregroundStyle(Color(Tokens.textSecondary))
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
