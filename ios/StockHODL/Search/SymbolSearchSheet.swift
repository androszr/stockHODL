import SwiftUI

/// Find a stock — and then either look at it or start watching it.
///
/// It borrows the transaction form's search — same combobox, same debounce,
/// same degraded handling — because there is exactly one symbol search in this
/// app and a second copy would drift.
///
/// Two actions per row, and the order matters: the ROW opens the stock, and
/// watching is the smaller trailing control. Picking a result used to watch it
/// outright, which forced a decision before you could see a price — the one
/// thing a watchlist entry is for. Now you look first. The direct watch stays
/// because this sheet is reached from the Watchlist tab's `+`, where "watch
/// this" is the reason you opened it, and making that a three-tap trip through
/// another screen would be a worse flow, not a better one.
struct SymbolSearchSheet: View {
    @State var form: TransactionFormStore
    let recents: RecentSymbolsStore
    let onOpen: (String) -> Void
    let onWatch: (SymbolMatch) -> Void
    /// Whether a symbol is already on the watchlist — asked per row so the
    /// button can say "Watching" instead of offering a duplicate add.
    let isWatched: (String) -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    /// Display-only optimism: the flip to "Watching" is the tap's feedback,
    /// and `store.add`'s refresh has not landed yet in the frame after it.
    /// If the add fails the store's own alert names it; the narrow window
    /// where this shows "Watching" for a failed add closes with the sheet.
    @State private var justWatched: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search a ticker or a name", text: $query)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.characters)
                        .onChange(of: query) { _, value in form.search(value) }
                } footer: {
                    if form.searchDegraded {
                        Text("Search is unavailable right now.")
                    }
                }

                if query.trimmed().isEmpty, recents.items.isEmpty {
                    // A fresh install must never open onto a blank sheet —
                    // one hint line stands in until there is a first recent.
                    Text("Type a ticker or a company name — Nvidia or NVDA both work.")
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textMuted))
                }

                if query.trimmed().isEmpty, !recents.items.isEmpty {
                    Section("Recently searched") {
                        ForEach(recents.items, id: \.symbol) { item in
                            Button {
                                recents.record(symbol: item.symbol, name: item.name)
                                dismiss()
                                onOpen(item.symbol)
                            } label: {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.symbol)
                                        .font(.system(.subheadline, weight: .semibold))
                                    Text(item.name)
                                        .font(.caption)
                                        .foregroundStyle(Color(Tokens.textSecondary))
                                        .lineLimit(1)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                ForEach(form.matches, id: \.symbol) { match in
                    HStack(spacing: 12) {
                        Button {
                            recents.record(symbol: match.symbol, name: match.name)
                            dismiss()
                            onOpen(match.symbol)
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 6) {
                                    Text(match.symbol)
                                        .font(.system(.subheadline, weight: .semibold))
                                    Text(match.exchangeDisplay)
                                        .font(.caption2)
                                        .foregroundStyle(Color(Tokens.textMuted))
                                }
                                Text(match.name)
                                    .font(.caption)
                                    .foregroundStyle(Color(Tokens.textSecondary))
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            // The whole row, not just the words: a tap target
                            // that only covers a short ticker is a tap target
                            // that misses.
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        // The word and the fill carry the state, never the
                        // color alone — the same Watch/Watching vocabulary the
                        // instrument screen's own control uses, reused rather
                        // than respelled. Watching does NOT dismiss: the flip
                        // to "Watching" is the feedback, and several stocks
                        // can be watched in one visit.
                        let watched = isWatched(match.symbol) || justWatched.contains(match.symbol)
                        Button {
                            justWatched.insert(match.symbol)
                            // Watching a stock is as much a lookup as opening
                            // it — it must surface in "Recently searched" too.
                            recents.record(symbol: match.symbol, name: match.name)
                            onWatch(match)
                        } label: {
                            Label(
                                watched ? "Watching" : "Watch",
                                systemImage: watched ? "binoculars.fill" : "binoculars"
                            )
                            .font(.system(.caption, weight: .semibold))
                            .foregroundStyle(Color(watched ? Tokens.textMuted : Tokens.accent))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            // The stroke is what makes it read as a control
                            // separate from the row whose tap does something
                            // else.
                            .overlay(Capsule().stroke(Color(Tokens.borderSubtle)))
                            // The capsule stays compact; the frame is what
                            // meets the 44pt tap-target floor.
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(watched)
                        .accessibilityLabel(
                            watched ? "Watching \(match.symbol)" : "Watch \(match.symbol)"
                        )
                    }
                }
            }
            .navigationTitle("Find a stock")
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
