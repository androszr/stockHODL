import SwiftUI

/// Every transaction, newest day first, with add / edit / delete.
struct TransactionsView: View {
    let store: TransactionsStore
    /// Threaded through to the add sheet. Optional so this view stays
    /// constructible from fakes alone.
    var imports: ImportStore?
    /// Owned by the shell so the persistent top bar can open this sheet —
    /// the system toolbar that used to hold the plus is hidden.
    @Binding var isAdding: Bool
    /// Builds a form store. Injected rather than constructed here so this view
    /// never names the auth store, and a test can drive it with fakes.
    let makeForm: (TransactionRow?) -> TransactionFormStore

    @State private var editing: TransactionRow?

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle("Transactions")
        .navigationBarTitleDisplayMode(.inline)
        // Keyed on the store's identity for the same reason the instrument
        // screen's is — see the note there.
        .task(id: ObjectIdentifier(store)) { await store.load() }
        .sheet(isPresented: $isAdding) {
            TransactionFormView(
                store: makeForm(nil),
                onSaved: { Task { await store.load() } },
                imports: imports
            )
        }
        .sheet(item: $editing) { row in
            TransactionFormView(store: makeForm(row)) {
                Task { await store.load() }
            }
        }
        .alert(
            store.staleNotice ?? store.errorMessage ?? "",
            isPresented: .init(
                get: { store.staleNotice != nil || (store.errorMessage != nil && !store.rows.isEmpty) },
                set: { if !$0 { store.dismissNotice() } }
            )
        ) {
            Button("OK") { store.dismissNotice() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.rows.isEmpty {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.rows.isEmpty {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.load() }
            }
        } else if store.rows.isEmpty {
            EmptyState(
                title: "No transactions yet",
                explanation: "Your buys, sells, and other activity will appear here.",
                action: .init(
                    label: "Record a transaction",
                    run: { isAdding = true }
                )
            )
        } else {
            list
        }
    }

    private var list: some View {
        // A journal painted from disk owes the same disclosure the price
        // screens do — less urgently, since a March purchase does not go
        // stale, but a list that is quietly MISSING a row the user added on
        // the web is the failure worth admitting to.
        VStack(spacing: 0) {
            StaleBar(freshness: store.freshness)
            journal
        }
    }

    private var journal: some View {
        List {
            ForEach(store.sections, id: \.date) { section in
                Section {
                    ForEach(section.rows, id: \.id) { row in
                        Button { editing = row } label: {
                            TransactionLine(row: row)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(Color(Tokens.surface1))
                        .swipeActions(edge: .trailing) {
                            // Destructive and irreversible, so it is a swipe
                            // plus a confirmation rather than a tap.
                            Button(role: .destructive) {
                                Task { await store.delete(row) }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text(section.date)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await store.load() }
    }
}

/// `sheet(item:)` needs identity, and the row already has one.
extension TransactionRow: Identifiable {}
