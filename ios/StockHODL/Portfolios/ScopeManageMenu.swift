import SwiftUI

/// The selected portfolio's management control: a bare "⋯" menu carrying
/// rename, move and delete, with the transaction count as its section header.
///
/// Rendered ONLY when a portfolio is selected — the daily-glance "All" view
/// carries no management chrome at all, which is the web's rule and the reason
/// this is a separate view rather than a menu on every chip. It used to be a
/// full-width row of its own; it lives inside `HoldingsHeaderBand` now, and
/// the count it used to show beside itself moved into the menu.
///
/// Confirmation is a `confirmationDialog` and it NAMES the portfolio and its
/// transaction count. A delete here cascades to those transactions, and a
/// dialog that said "Are you sure?" would be asking the user to remember how
/// much they were about to lose.
struct ScopeManageMenu: View {
    let scope: ScopeChip
    /// Every portfolio id in display order — what Move earlier/later rewrites.
    let ordered: [String]
    let isBusy: Bool
    let onRename: () -> Void
    let onMove: (Int) -> Void
    let onDelete: () -> Void

    @State private var isConfirmingDelete = false

    private var index: Int? { ordered.firstIndex(of: scope.id) }
    private var canMoveEarlier: Bool { (index ?? 0) > 0 }
    private var canMoveLater: Bool {
        guard let index else { return false }
        return index < ordered.count - 1
    }

    var body: some View {
        Menu {
            // The count the old row showed beside itself — a section header
            // keeps the figure in reach without a row of its own.
            Section(ScopeManageMenu.transactionLabel(scope.txCount)) {
                Button {
                    onRename()
                } label: {
                    Label("Rename", systemImage: "pencil")
                }

                // Earlier / later rather than a drag: dragging pills inside a
                // horizontal scroller fights the scroll gesture, and with a
                // handful of portfolios one tap per slot is cheaper.
                Button {
                    onMove(-1)
                } label: {
                    Label("Move earlier in the list", systemImage: "chevron.left")
                }
                .disabled(!canMoveEarlier)

                Button {
                    onMove(1)
                } label: {
                    Label("Move later in the list", systemImage: "chevron.right")
                }
                .disabled(!canMoveLater)

                Button(role: .destructive) {
                    isConfirmingDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color(Tokens.textSecondary))
                // 44pt is the tap-target floor.
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(isBusy)
        .accessibilityLabel("Manage \(scope.name)")
        .confirmationDialog(
            "Delete “\(scope.name)”?",
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete portfolio", role: .destructive, action: onDelete)
            Button("Cancel", role: .cancel) {}
        } message: {
            // The count is the whole point of the message: the cascade takes
            // these rows with it, and this is the last place to say so.
            Text("Its \(ScopeManageMenu.transactionLabel(scope.txCount)) go with it. This cannot be undone.")
        }
    }

    /// "1 transaction" / "12 transactions". A count, never money.
    static func transactionLabel(_ count: Int?) -> String {
        guard let count else { return "" }
        return count == 1 ? "1 transaction" : "\(count) transactions"
    }
}

/// Naming a portfolio — create and rename share it, because they ask the same
/// question and refuse for the same reasons.
///
/// A sheet rather than an `alert` with a text field: the alert variant cannot
/// show the server's refusal (a duplicate name) without dismissing first, and
/// re-opening an alert to say why the last one failed loses what was typed.
struct PortfolioNameSheet: View {
    let title: String
    let confirmLabel: String
    /// Server-side bound, restated so the field can stop rather than let a
    /// long name travel and come back rejected.
    static let maxLength = 60

    @State private var name: String
    private let isBusy: Bool
    private let errorMessage: String?
    private let onSubmit: (String) -> Void
    private let onCancel: () -> Void

    init(
        title: String,
        confirmLabel: String,
        initialName: String = "",
        isBusy: Bool,
        errorMessage: String?,
        onSubmit: @escaping (String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.title = title
        self.confirmLabel = confirmLabel
        _name = State(initialValue: initialName)
        self.isBusy = isBusy
        self.errorMessage = errorMessage
        self.onSubmit = onSubmit
        self.onCancel = onCancel
    }

    private var trimmed: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("e.g. IKE", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { submit() }
                        .onChange(of: name) { _, value in
                            if value.count > PortfolioNameSheet.maxLength {
                                name = String(value.prefix(PortfolioNameSheet.maxLength))
                            }
                        }
                } footer: {
                    if let errorMessage {
                        // The server's own sentence — a duplicate name is the
                        // realistic refusal and it says which name.
                        Text(errorMessage).foregroundStyle(Color(Tokens.loss))
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(Tokens.surface0))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(isBusy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmLabel) { submit() }
                        .disabled(isBusy || trimmed.isEmpty)
                }
            }
        }
    }

    private func submit() {
        guard !trimmed.isEmpty, !isBusy else { return }
        onSubmit(trimmed)
    }
}
