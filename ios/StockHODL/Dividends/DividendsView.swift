import SwiftUI

/// Every dividend the ledger has recorded, newest year first — the phone's
/// half of `/dividends`.
///
/// The two "excluded" counts are rendered SEPARATELY and always. A row the
/// next NBP sync can still rate and a row whose currency has no PLN route at
/// all look identical in a total and mean opposite things — one is arriving,
/// one never will.
///
/// Writing is here now: add a payment the feed missed, correct one it got
/// wrong, delete one, and re-ask the vendor. All four go through the same
/// `src/lib/dividends/mutations.ts` the web's Server Actions use, so there is
/// one implementation of a record the user may file taxes from.
///
/// Correcting a row sets `edited` server-side, and from then on no refresh
/// ever touches it — the user's correction always wins. The screen says so
/// where a row is marked, because that is the guarantee that makes hand-editing
/// a tax record safe at all.
struct DividendsView: View {
    let store: DividendsStore
    /// Narrowed to one of the user's own symbols, or nil for the whole ledger.
    /// Re-validated server-side: a stale value widens rather than erroring.
    var symbol: String?
    /// Builds a form store for add (nil) or correct (a payment). Absent in
    /// previews and tests, and then the screen is simply read-only — which is
    /// what a screen built without a network should be.
    var makeForm: ((DividendPayment?) -> DividendFormStore)?

    /// Which form is up. An enum rather than two flags: add and correct are
    /// the same sheet asking about a different row, and two booleans could
    /// both be true.
    @State private var editing: FormTarget?
    @State private var pendingDeletion: DividendPayment?

    /// `Identifiable` so it can drive `.sheet(item:)`, which is what makes the
    /// sheet's seeded draft correct — `.sheet(isPresented:)` builds the view
    /// before the target is set. Not `Equatable`: the generated
    /// `DividendPayment` is not, and the payment id is the identity anyway.
    fileprivate enum FormTarget: Identifiable {
        case add
        case correct(DividendPayment)

        var id: String {
            switch self {
            case .add: "add"
            case let .correct(payment): payment.id
            }
        }
    }

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle(symbol.map { "\($0) dividends" } ?? "Dividends")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load(symbol: symbol) }
        .sheet(item: $editing) { target in
            if let makeForm {
                DividendFormView(
                    store: makeForm(target.payment),
                    onSaved: { Task { await store.reload() } }
                )
            }
        }
        .confirmationDialog(
            "Delete this payment?",
            isPresented: .init(
                get: { pendingDeletion != nil },
                set: { if !$0 { pendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                guard let payment = pendingDeletion else { return }
                pendingDeletion = nil
                Task { await store.delete(payment) }
            }
            Button("Cancel", role: .cancel) { pendingDeletion = nil }
        } message: {
            // A vendor row is tombstoned rather than erased, which is what
            // stops the next sync from quietly putting it back. Worth saying,
            // because "it will come back" is the reasonable fear.
            Text("It stays deleted — a future refresh will not bring it back.")
        }
        .alert(
            store.errorMessage ?? "",
            isPresented: .init(
                get: { store.errorMessage != nil && !store.payments.isEmpty },
                set: { if !$0 { store.dismissError() } }
            )
        ) {
            Button("OK") { store.dismissError() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.payments.isEmpty {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.payments.isEmpty {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.reload() }
            }
        } else if store.hasLoaded, store.payments.isEmpty {
            emptyState
        } else {
            list
        }
    }

    private var emptyState: some View {
        EmptyState(
            title: "No dividends yet.",
            // The first load runs a sync server-side, so "nothing yet" here
            // means the ledger really has none — not that nobody has looked.
            explanation: "Payments appear here once a holding of yours pays one.",
            // The designed remedy for what the feed cannot derive — shares
            // held at a broker before the trades were recorded here.
            action: makeForm != nil ? .init(
                label: "Add one by hand",
                run: { editing = .add }
            ) : nil
        )
        .padding(24)
    }

    /// Add and re-sync. A row of two, above the summary: the primary action on
    /// this screen is adding what the feed missed, and burying it in a menu
    /// would make the read-only version of this screen indistinguishable.
    @ViewBuilder
    private var actions: some View {
        if makeForm != nil {
            HStack(spacing: 8) {
                Button {
                    editing = .add
                } label: {
                    Label("Add payment", systemImage: "plus")
                        .font(.system(.footnote, weight: .medium))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color(Tokens.accent))
                .background(Color(Tokens.surface1))
                .clipShape(RoundedRectangle(cornerRadius: 10))

                Button {
                    Task { await store.refreshFromVendor() }
                } label: {
                    HStack(spacing: 6) {
                        if store.isSyncing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                        Text("Refresh")
                    }
                    .font(.system(.footnote, weight: .medium))
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .disabled(store.isSyncing)
                .foregroundStyle(Color(Tokens.textSecondary))
                .background(Color(Tokens.surface1))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .padding(.horizontal, 16)
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20, pinnedViews: [.sectionHeaders]) {
                StaleBar(freshness: store.freshness)

                actions

                if let summary = store.summary {
                    DividendSummaryCard(summary: summary)
                        .padding(.horizontal, 16)
                }

                ForEach(store.years, id: \.year) { group in
                    Section {
                        VStack(spacing: 0) {
                            ForEach(store.payments(in: group), id: \.id) { payment in
                                if makeForm == nil {
                                    DividendRow(payment: payment)
                                } else {
                                    Button {
                                        editing = .correct(payment)
                                    } label: {
                                        DividendRow(payment: payment)
                                    }
                                    .buttonStyle(.plain)
                                    // A long-press menu rather than a swipe:
                                    // `swipeActions` only exists inside a
                                    // `List`, and this is a `LazyVStack` —
                                    // the year headers pin, which a List
                                    // cannot do here. Rather than a per-row
                                    // trash icon, which would put a
                                    // destructive target on every line of a
                                    // list that is scanned far more often
                                    // than it is edited.
                                    .contextMenu {
                                        Button {
                                            editing = .correct(payment)
                                        } label: {
                                            Label("Edit", systemImage: "pencil")
                                        }
                                        Button(role: .destructive) {
                                            pendingDeletion = payment
                                        } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
                                    }
                                }
                                if payment.id != store.payments(in: group).last?.id {
                                    Divider().overlay(Color(Tokens.borderSubtle))
                                }
                            }
                        }
                        .background(Color(Tokens.surface1))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal, 16)
                    } header: {
                        DividendYearHeader(group: group)
                    }
                }

                footer
            }
            .padding(.vertical, 12)
        }
        .refreshable { await store.reload() }
    }

    private var footer: some View {
        // The one rule that makes hand-editing a tax record safe, stated where
        // the hand-edited rows are.
        Text("A payment you add or correct is never overwritten by a refresh.")
            .font(.caption2)
            .foregroundStyle(Color(Tokens.textMuted))
            .padding(.horizontal, 16)
            .padding(.top, 4)
    }
}

/// Net received, and what is missing from it.
private struct DividendSummaryCard: View {
    let summary: DividendSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                figure("Net received", summary.netPLN)
                Spacer()
                figure("This year", summary.ytdNetPLN)
            }

            Text("\(summary.count) \(summary.count == 1 ? "payment" : "payments")")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))

            // Both counts, separately, never summed into one "missing".
            if summary.awaitingFx > 0 {
                caption("\(summary.awaitingFx) awaiting an exchange rate — the next sync fills them in.")
            }
            if summary.fxUnsupported > 0 {
                caption("\(summary.fxUnsupported) in a currency with no PLN rate — only a hand-entered rate can total these.")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func figure(_ label: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            // Formatted from the decimal string the server folded, never from
            // a sum taken here. A null total is an em dash rather than a zero:
            // "nothing summable" and "zero received" are different facts.
            Text(value.flatMap { dec($0) }.map { fmtMoney($0, currency: "PLN") } ?? "—")
                .font(.system(.title3, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Color(Tokens.textPrimary))
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(Color(Tokens.textMuted))
    }
}

private struct DividendYearHeader: View {
    let group: DividendYearGroup

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(group.year)
                .font(.system(.subheadline, weight: .semibold))
                .foregroundStyle(Color(Tokens.textPrimary))
            Spacer()
            if let netPLN = group.netPLN, let value = dec(netPLN) {
                Text(fmtMoney(value, currency: "PLN"))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textSecondary))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(Color(Tokens.surface0))
    }
}

private struct DividendRow: View {
    let payment: DividendPayment

    var body: some View {
        HStack(spacing: 12) {
            TickerLogo(symbol: payment.symbol, size: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(payment.symbol)
                    .font(.system(.subheadline, weight: .medium))
                    .foregroundStyle(Color(Tokens.textPrimary))
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                // NET, already derived server-side on Decimal — the phone
                // never subtracts withholding from gross itself.
                Text(dec(payment.netAmount).map { fmtMoney($0, currency: payment.currency) } ?? "—")
                    .font(.system(.subheadline, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
                if let gap = payment.fxGap {
                    Text(gap == .awaiting ? "awaiting rate" : "no PLN rate")
                        .font(.caption2)
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var subtitle: String {
        var parts = [payment.effectiveDate]
        // An announcement is not money received, and the row says which it is.
        if payment.isAnnouncedOnly { parts.append("ex-date") }
        if let perShare = dec(payment.amountPerShare), let quantity = dec(payment.quantity) {
            parts.append("\(fmtQuantity(quantity)) × \(fmtMoney(perShare, currency: payment.currency))")
        }
        if payment.edited { parts.append("edited") }
        return parts.joined(separator: " · ")
    }
}

extension DividendsView.FormTarget {
    /// The row the sheet is about, or nil when adding.
    var payment: DividendPayment? {
        switch self {
        case .add: nil
        case let .correct(payment): payment
        }
    }
}
