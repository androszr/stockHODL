import SwiftUI

/// The Options tab — first ported from the retired web app's options screen.
///
/// Market bar, the USD summary, the combined-value chart, one card per tracked
/// CONTRACT (two purchases of one OCC ticker are aggregated into a single card
/// upstream, in `composeOptionsPayload`), and the expired toggle.
///
/// The summary and the chart render only when contracts are visible — a
/// "Total value —" header floating over "No contracts yet" would be noise, not
/// honesty.
///
/// The `scenePhase` wiring is NOT here: it is in `SignedInView`, above every
/// tab, because a store that only hears about the foreground while its own tab
/// is on screen hears about it almost never.
struct OptionsView: View {
    let store: OptionsStore
    /// Presented for an add or an edit. Built by the caller so this view stays
    /// ignorant of the auth store.
    /// Threaded to the add sheet. Optional so this view stays constructible
    /// from fakes alone.
    var imports: ImportStore?
    /// Owned by the shell so the persistent top bar's plus can open this
    /// sheet — the `WatchlistView` pattern. The in-list dashed "Add contract"
    /// button opens the SAME sheet by setting `form` directly, so the two
    /// entry points never disagree about what "add" means.
    @Binding var isAdding: Bool
    let makeFormStore: (OptionFormStore.Mode) -> OptionFormStore

    @State private var form: OptionFormStore?
    @State private var pendingRemoval: OptionLotItem?

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .task { await store.start() }
        .onChange(of: isAdding) { _, adding in
            guard adding else { return }
            form = makeFormStore(.add)
            isAdding = false
        }
        .sheet(item: $form) { formStore in
            OptionFormView(store: formStore, optionsStore: store, imports: imports)
        }
        .confirmationDialog(
            "Remove this purchase?",
            isPresented: .init(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingRemoval
        ) { lot in
            // Labelled with the LOT it addresses, never with the card: a card
            // can stand for several purchases and a confirmation that named
            // the wrong one would be worse than no confirmation.
            Button("Remove \(lot.tradeDateLabel) · \(lot.quantity) @ \(lot.entryPrice)",
                   role: .destructive) {
                let id = lot.id
                pendingRemoval = nil
                Task { await store.remove(lotID: id) }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        }
        .alert(
            "Something went wrong",
            isPresented: .init(
                get: { store.errorMessage != nil },
                set: { if !$0 { store.dismissError() } }
            ),
            presenting: store.errorMessage
        ) { _ in
            Button("OK") { store.dismissError() }
        } message: { message in
            Text(message)
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.payload == nil {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.refresh() }
            }
        } else {
            loaded
        }
    }

    private var loaded: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                // The Options tab had `isOffline` and drew nothing for it —
                // the flag existed, was maintained on every refresh, and no
                // pixel ever read it. A book of contracts priced an hour ago
                // looked exactly like one priced a second ago.
                StaleBar(freshness: store.freshness)

                if let market = store.payload?.market {
                    MarketStatusBar(market: market)
                }

                if !store.visibleItems.isEmpty {
                    if let summary = store.visibleSummary {
                        SummaryHeader(summary: summary)
                        ForEach(store.visibleSummaryNotes, id: \.self) { note in
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(Color(Tokens.textMuted))
                        }
                    }
                    chart
                }

                if store.payload?.items.isEmpty ?? true {
                    empty
                } else {
                    controls
                    if store.allHidden {
                        // Contracts exist but every one is hidden: say so in
                        // words rather than show an empty grid under a live
                        // market bar.
                        Text("All tracked contracts have expired.")
                            .font(.subheadline)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                    cards
                }

                addButton
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .refreshable { await store.refresh() }
    }

    private var chart: some View {
        VStack(spacing: 4) {
            ValueChart(
                points: store.series?.points ?? [],
                // Decided by the store, which knows which range the points
                // were fetched for — a series still in flight for a newly
                // tapped tab is loading, not the previous tab's chart.
                state: store.seriesState,
                granularity: store.range.granularity,
                // USD, deliberately and always: these contracts trade in
                // dollars and this tab stays outside the złoty totals.
                currency: "USD",
                excludedSymbols: store.series?.excludedSymbols ?? [],
                partialDays: store.series?.partialDays ?? 0,
                estimatedFrom: store.series?.estimatedFrom,
                emptyMessage: "No recorded marks for this range yet.",
                unit: store.chartMode == .percentReturn ? .percent : .money,
                mode: store.chartMode,
                windowLabel: store.range.windowLabel,
                // Every card in the payload, not the filtered card list this
                // screen shows: the series is the whole book, expired
                // contracts included, so hiding those marks would strand
                // purchases the line itself still contains.
                trades: TradeMark.fromLots(store.payload?.items ?? [])
                // No `matchOnPrice`: the line is a total, not a premium.
            )
            HStack(alignment: .center, spacing: 8) {
                RangeTabs(selected: store.range) { store.range = $0 }
                // Value or Return, display-only: both curves ride in the same
                // payload, so this never costs a request.
                ChartToggle(
                    selected: store.chartMode,
                    accessibilityName: "Chart mode"
                ) { store.chartMode = $0 }
                .fixedSize()
                .padding(.trailing, 16)
            }
        }
    }

    private var controls: some View {
        HStack {
            if store.expiredCount > 0 {
                Button {
                    store.showExpired.toggle()
                } label: {
                    Text("\(store.expiredCount) expired — \(store.showExpired ? "hide" : "show")")
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textMuted))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                // A DISCLOSURE, not a toggle: it reveals content, and its
                // label is a verb that flips with the state. Under
                // `isSelected` a screen reader would announce the inverse of
                // what the label says — the exact bug the web fixed.
                .accessibilityAddTraits(store.showExpired ? [.isSelected] : [])
            }
            Spacer(minLength: 0)
            SortMenu(selected: store.sort) { store.sort = $0 }
        }
    }

    private var cards: some View {
        ForEach(store.visibleItems, id: \.key) { item in
            NavigationLink(value: Route.optionContract(item.key)) {
                OptionCardView(
                    item: item,
                    onEdit: { lot in form = makeFormStore(.edit(lot)) },
                    onRemove: { lot in pendingRemoval = lot }
                )
            }
            .buttonStyle(.plain)
        }
    }

    private var addButton: some View {
        Button {
            form = makeFormStore(.add)
        } label: {
            Label("Add contract", systemImage: "plus")
                .font(.subheadline)
                .foregroundStyle(Color(Tokens.accent))
                .frame(maxWidth: .infinity, minHeight: 48)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(
                            Color(Tokens.borderStrong),
                            style: StrokeStyle(lineWidth: 1, dash: [4, 4])
                        )
                )
        }
        .padding(.top, 4)
    }

    /// A deliberately empty list is neither an error nor missing data
    /// (the watchlist's shape).
    private var empty: some View {
        EmptyState(
            title: "No contracts yet",
            explanation: "Add one below — pick a stock, an expiry, call or put, then a strike."
        )
        .padding(.top, 40)
    }
}

extension TradeMark {
    /// Option lots as chart marks.
    ///
    /// Always `.buy`, and that is a fact rather than a default:
    /// `option_positions` carries no side column — every lot is an opening
    /// purchase — so the callout says BUY and never guesses at a sale that
    /// cannot be recorded.
    ///
    /// `unitPriceRaw` is nil because neither options chart matches on price:
    /// both plot a total, and a premium has nothing to be nearest to on one.
    /// The three display strings are the SERVER's own, the same ones
    /// `OptionCardView.lotLabel` shows in the menu, and the label is the
    /// card's own headline — so a mark on the whole-book line says WHICH
    /// contract it was, not just how many.
    static func fromLots(_ items: [OptionCardItem]) -> [TradeMark] {
        items.flatMap { item in
            item.lots.map { lot in
                TradeMark(
                    id: lot.id,
                    label: OptionCardView.headline(for: item),
                    side: .buy,
                    tradeDate: lot.tradeDate,
                    unitPriceRaw: nil,
                    quantityText: lot.quantity,
                    priceText: lot.entryPrice,
                    dateText: lot.tradeDateLabel
                )
            }
        }
    }
}
