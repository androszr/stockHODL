import SwiftUI

/// Add or correct one dividend payment — the phone's `/dividends/new` and
/// `/dividends/[id]`.
///
/// The form collects gross and withholding and submits them as typed. It never
/// shows a running net: net is derived server-side on `Decimal` and rides back
/// on the row, and a second figure computed here would be a second opinion
/// about something the user may file taxes from.
///
/// Two things are LOCKED on an edit, and the form says so rather than offering
/// a control that will be refused: the instrument and the currency always (a
/// different company or currency is a different payment), and the PORTFOLIO as
/// well on a vendor-sourced row — moving one would vacate its key for the next
/// sync to re-fill, and the same dividend would then count twice.
struct DividendFormView: View {
    @State var store: DividendFormStore
    /// Called after a successful save, so the list behind the sheet reloads.
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: DividendDraft.Field?

    var body: some View {
        NavigationStack {
            Form {
                if store.hasNothingToAttachTo {
                    nothingToAttachTo
                } else {
                    instrumentSection
                    paymentSection
                    fxSection
                    noteSection
                }

                if let message = store.errorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.loss))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(Tokens.surface0))
            .navigationTitle(store.editing == nil ? "Add dividend" : "Edit dividend")
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await store.save() } }
                        .disabled(!store.canSave || store.hasNothingToAttachTo)
                }
            }
            .task { await store.loadOptions() }
            .onChange(of: store.didSave) { _, saved in
                if saved {
                    onSaved()
                    dismiss()
                }
            }
            .onChange(of: focused) { previous, _ in
                // Validation happens when a field is LEFT, so the form does
                // not go red under a thumb that is still typing.
                if let previous { store.markTouched(previous) }
            }
        }
    }

    /// A dividend attaches to a stock the ledger already knows about, and this
    /// path can never mint one. Saying so beats two empty pickers.
    private var nothingToAttachTo: some View {
        Section {
            Text("Record a transaction first")
                .font(.system(.subheadline, weight: .medium))
                .foregroundStyle(Color(Tokens.textSecondary))
            Text("A payment attaches to a stock you have traded and a portfolio it lives in.")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
        }
    }

    // MARK: - Instrument

    @ViewBuilder
    private var instrumentSection: some View {
        Section("Instrument") {
            if store.editing == nil {
                Picker(
                    "Stock",
                    selection: Binding(
                        get: { store.draft.instrumentId },
                        // Through the store, never straight onto the draft:
                        // the currency travels with the instrument, and
                        // letting them drift apart would file a payment in
                        // money the stock does not trade in.
                        set: { store.choose(instrumentId: $0) }
                    )
                ) {
                    Text("Pick one").tag("")
                    ForEach(store.instruments, id: \.id) { instrument in
                        Text("\(instrument.symbol) · \(instrument.displayName)").tag(instrument.id)
                    }
                }
            } else {
                LabeledContent("Stock", value: store.instrumentLabel ?? "—")
                Text("To change the stock or the currency, delete this payment and add it again.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            // Never editable: it belongs to the instrument, and the server
            // refuses to rebind it on an edit.
            LabeledContent("Currency", value: store.draft.currency.rawValue)

            if store.editing != nil, store.isVendorRow {
                LabeledContent(
                    "Portfolio",
                    value: store.portfolios.first { $0.id == store.draft.portfolioId }?.name ?? "—"
                )
                Text("A fetched payment can't move to another portfolio — the next refresh would re-create it in the old one.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            } else if store.portfolios.count > 1 || store.draft.portfolioId.isEmpty {
                Picker("Portfolio", selection: $store.draft.portfolioId) {
                    Text("Pick one").tag("")
                    ForEach(store.portfolios, id: \.id) { portfolio in
                        Text(portfolio.name).tag(portfolio.id)
                    }
                }
            }
        }
    }

    // MARK: - Payment

    private var paymentSection: some View {
        Section("Payment") {
            FormField(
                title: "Ex-date",
                text: $store.draft.exDate,
                field: DividendDraft.Field.exDate,
                issue: store.issue(for: .exDate),
                focused: $focused,
                placeholder: "YYYY-MM-DD"
            )
            FormField(
                title: "Pay date",
                text: $store.draft.payDate,
                field: DividendDraft.Field.payDate,
                issue: store.issue(for: .payDate),
                focused: $focused,
                placeholder: "not paid yet"
            )
            FormField(
                title: "Quantity",
                text: $store.draft.quantity,
                field: DividendDraft.Field.quantity,
                issue: store.issue(for: .quantity),
                focused: $focused,
                keyboard: .decimalPad
            )
            FormField(
                title: "Per share",
                text: $store.draft.amountPerShare,
                field: DividendDraft.Field.amountPerShare,
                issue: store.issue(for: .amountPerShare),
                focused: $focused,
                keyboard: .decimalPad
            )
            FormField(
                title: "Gross",
                text: $store.draft.grossAmount,
                field: DividendDraft.Field.grossAmount,
                issue: store.issue(for: .grossAmount),
                focused: $focused,
                keyboard: .decimalPad
            )
            FormField(
                title: "Withheld tax",
                text: $store.draft.withheldTax,
                field: DividendDraft.Field.withheldTax,
                issue: store.issue(for: .withheldTax),
                focused: $focused,
                keyboard: .decimalPad,
                placeholder: "0"
            )
        }
    }

    // MARK: - FX

    private var fxSection: some View {
        Section {
            FormField(
                title: "Rate to PLN",
                text: $store.draft.fxRateToBase,
                field: DividendDraft.Field.fxRateToBase,
                issue: store.issue(for: .fxRateToBase),
                focused: $focused,
                keyboard: .decimalPad,
                placeholder: "not published"
            )
        } header: {
            Text("FX rate")
        } footer: {
            // Left blank the row still counts as received — it simply cannot
            // enter the PLN totals yet, and the list says which rows those
            // are. A fabricated 1 would silently make a dollar a złoty.
            Text("Leave blank until the NBP rate is published. The payment still shows; it stays out of the PLN totals until a rate exists.")
                .font(.caption2)
        }
    }

    private var noteSection: some View {
        Section("Note") {
            TextField("Optional", text: $store.draft.note, axis: .vertical)
                .lineLimit(1...4)
        }
    }
}
