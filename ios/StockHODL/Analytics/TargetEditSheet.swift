import Foundation
import SwiftUI

/// Set one portfolio's target mix: a percent field per holding, a running
/// total, and one Save that replaces the whole list.
///
/// Three rules do the load-bearing work here.
///
/// **Blank means NO target.** A cleared field is omitted from the body
/// entirely — never sent as `"0"`, which the server refuses anyway, and which
/// would show every held stock as overweight with a sell order attached.
///
/// **The seeds come from a fresh GET, not from the drift payload.** The
/// analytics response can be minutes old off the disk cache; seeding from it
/// would let a save built on stale values clobber a target set elsewhere,
/// and a bulk replace has no way to notice.
///
/// **A sheet that never seeded cannot save.** Save is a BULK REPLACE, so an
/// unseeded sheet saves an empty list and deletes every stored target — one
/// network hiccup on open would silently wipe the lot. So Save stays disabled
/// until the GET has actually answered, with a Try-again button in its place.
/// Clearing every target on purpose is still one tap away: empty the fields on
/// a sheet that DID seed.
///
/// The rows are the union of the drift payload's rows (every held and
/// targeted instrument the cached payload knows about) and the GET's own rows
/// (every instrument the server currently has a target for). The union is
/// what stops a target the stale payload has not heard of from being deleted
/// without a word — the GET carries the symbol so such a row can be named
/// rather than invented.
///
/// The running total is `Decimal` via `strictDecimal`, the same parser the
/// transaction form uses. Nothing here is ever converted to a Double: these are
/// user-typed percents that multiply money on the server.
struct TargetEditSheet: View {
    let store: AnalyticsStore
    let portfolioId: String
    let rows: [AnalyticsTargetDriftRow]

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: String?
    /// instrumentId → what the user typed. A missing or blank entry is NO
    /// target, which is why this is a dictionary of strings and not of
    /// numbers with a zero default.
    @State private var drafts: [String: String] = [:]
    @State private var issue: String?
    @State private var isSaving = false
    @State private var isSeeding = true
    /// What the SERVER currently has a target for, or nil while the seeding
    /// GET has yet to succeed. nil is the whole guard against a failed seed
    /// turning Save into a wipe.
    @State private var seededRows: [TargetRow]?

    /// One editable line: an instrument and the name to print above its field.
    private struct EditRow: Identifiable {
        let instrumentId: String
        let symbol: String
        var id: String { instrumentId }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(editRows) { row in
                        field(for: row)
                    }
                } footer: {
                    footer
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(Tokens.surface0))
            .navigationTitle("Target weights")
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!canSave)
                }
            }
            .task { await seed() }
        }
    }

    /// Save is a bulk replace, so it is only ever offered over a list that
    /// came from the server. `seededRows == nil` means the GET has not
    /// answered — saving then would send an empty body and clear everything.
    private var canSave: Bool {
        !isSaving && !isSeeding && seededRows != nil
    }

    /// Every instrument the sheet may set a target for: the drift payload's
    /// rows, plus any instrument the server has a target for that the payload
    /// does not list. Without the second half, a bulk-replace save would drop
    /// that target on the floor.
    private var editRows: [EditRow] {
        var out = rows.map { EditRow(instrumentId: $0.instrumentId, symbol: $0.symbol) }
        var seen = Set(out.map(\.instrumentId))
        for row in seededRows ?? [] where !seen.contains(row.instrumentId) {
            // The symbol comes from the GET, not from a guess: the server
            // joins it in precisely so this row can be named.
            out.append(EditRow(instrumentId: row.instrumentId, symbol: row.symbol))
            seen.insert(row.instrumentId)
        }
        return out
    }

    private func field(for row: EditRow) -> some View {
        FormField(
            title: row.symbol,
            text: binding(for: row.instrumentId),
            field: row.instrumentId,
            issue: nil,
            focused: $focused,
            keyboard: .decimalPad,
            placeholder: "no target"
        )
    }

    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Total")
                Spacer()
                Text(totalLabel)
                    .monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(Color(Tokens.textPrimary))

            Text("Leave a field empty for no target — a blank is not a zero.")
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
                .fixedSize(horizontal: false, vertical: true)

            if let issue {
                Text(issue)
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textPrimary))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if seededRows == nil, !isSeeding {
                Text("Saving is off until the current targets load — a save replaces the whole list, and saving what never loaded would clear it.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .fixedSize(horizontal: false, vertical: true)

                Button("Try again") { Task { await seed() } }
                    .font(.callout)
                    .foregroundStyle(Color(Tokens.accent))
                    .frame(minHeight: 44)
                    .buttonStyle(.borderless)
            }
        }
    }

    private func binding(for instrumentId: String) -> Binding<String> {
        Binding(
            get: { drafts[instrumentId] ?? "" },
            set: { drafts[instrumentId] = $0 }
        )
    }

    /// Summed on `Decimal`, never on a float. A field that will not parse is
    /// simply not counted — the server's refusal names it on save, and a
    /// fabricated contribution would make the total lie while the user types.
    /// Counted over the rows that will actually be SENT, so the total cannot
    /// include a draft the save would leave behind.
    private var total: Decimal {
        editRows.reduce(Decimal(0)) { running, row in
            let normalized = normalizeDecimalSeparator(drafts[row.instrumentId] ?? "")
            guard !normalized.isEmpty, let value = strictDecimal(normalized) else { return running }
            return running + value
        }
    }

    private var totalLabel: String {
        // A percent typed by the user, printed back: two places, pl-PL, and
        // never fed into arithmetic afterwards.
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        let text = formatter.string(from: total as NSDecimalNumber) ?? "—"
        return "\(text)%"
    }

    /// Seed from the SERVER's current list. A row the server has no target
    /// for stays blank, which is the whole point.
    ///
    /// On failure `seededRows` stays nil and Save stays disabled: the sheet
    /// does not know what is stored, and a bulk replace built on not knowing
    /// deletes everything.
    private func seed() async {
        isSeeding = true
        issue = nil
        let seeded = await store.fetchTargets(portfolioId: portfolioId)
        isSeeding = false

        if let failure = seeded.failure {
            issue = failure
            return
        }

        for row in seeded.rows {
            // Never overwrite what the user typed while the sheet was
            // unseeded: a retry unlocks Save, it does not rewrite the form.
            guard (drafts[row.instrumentId] ?? "").isEmpty else { continue }
            drafts[row.instrumentId] = row.targetPct
        }
        // Set LAST: this is the flag that re-enables Save.
        seededRows = seeded.rows
    }

    private func save() async {
        // Belt and braces — the button is disabled, but a bulk replace over
        // an unknown current list is the one thing that must not happen.
        guard canSave else { return }

        var body: [TargetPutRow] = []
        for row in editRows {
            let normalized = normalizeDecimalSeparator(drafts[row.instrumentId] ?? "")
            // Blank = NO target: the row simply does not travel.
            guard !normalized.isEmpty else { continue }
            if let problem = decimalIssue(normalized, TargetEditSheet.percentBounds) {
                issue = "\(row.symbol): \(problem)"
                return
            }
            // `maxIntegerDigits` cannot express "at most 100", so the upper
            // bound is its own check — on Decimal, like every other one.
            if let value = strictDecimal(normalized), value > 100 {
                issue = "\(row.symbol): keep each target at 100% or less"
                return
            }
            body.append(TargetPutRow(instrumentId: row.instrumentId, targetPct: normalized))
        }

        issue = nil
        isSaving = true
        defer { isSaving = false }

        // The store answers the sentence to show — the server's own words for
        // a refusal, "You're offline — nothing was saved." for a write that
        // never left the device — or nil, having already reloaded the card.
        if let refusal = await store.saveTargets(portfolioId: portfolioId, rows: body) {
            issue = refusal
            return
        }
        dismiss()
    }

    /// `targetPctSchema`, ported: greater than zero, at most 100, at most two
    /// decimal places. The server is still the authority; this only turns the
    /// field's message local instead of costing a round trip.
    private static let percentBounds = DecimalBounds(
        positive: true,
        maxIntegerDigits: 3,
        maxScale: 2
    )
}
