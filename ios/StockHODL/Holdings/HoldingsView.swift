import SwiftUI

/// The Holdings screen: scope chips, the summary, and the cards.
///
/// It reads `LiveStore` and owns no data of its own — not even its lifecycle.
/// Starting the store and telling it about the foreground both belong to
/// `SignedInView`: the Dashboard draws the same store, and whichever tab is on
/// screen when the phone unlocks must not decide whether the app refreshes.
struct HoldingsView: View {
    let store: LiveStore
    /// Portfolio management. Optional so this screen still builds from a fake
    /// `LiveStore` alone: absent means the chips select and nothing more,
    /// which is exactly what a preview wants.
    var portfolios: PortfoliosStore?
    /// The value/return chart. Optional for the same reason: a preview built
    /// from a fake `LiveStore` shows the list without one.
    var chart: PortfolioChartStore?
    /// The transaction journal, for the trade markers on the chart. The SAME
    /// store the Transactions screen reads — hoisted in `RootView` precisely
    /// so a deletion there cannot leave a marker here. Optional like the rest,
    /// so this screen still builds from a fake `LiveStore` alone.
    var journal: TransactionsStore?
    /// Owned by the shell so the persistent top bar can open this sheet —
    /// the system toolbar that used to hold the plus is hidden. A holding
    /// has no add flow of its own: it IS its transactions, so this reuses
    /// the same form the Transactions screen opens.
    @Binding var isAddingTransaction: Bool
    /// Threaded through to the add sheet, same as `TransactionsView`.
    /// Optional so this view stays constructible from fakes alone.
    var imports: ImportStore?
    /// Builds a form store. Injected rather than constructed here so this
    /// view never names the auth store.
    var makeTransactionForm: (() -> TransactionFormStore)?

    /// The list's OWN remembered ordering, separate from the Dashboard's.
    @State private var sort = HoldingsSort.remembered(for: .holdings)
    /// Which naming sheet is up, if any. One enum rather than two booleans:
    /// create and rename ask the same question, and two flags could both be
    /// true.
    @State private var naming: NamingSheet?

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        // The store itself is started by the shell, which owns it and the
        // Dashboard that also reads it. The chart is this screen's alone.
        .task {
            chart?.loadIfNeeded()
            // The store paints from `DiskCache` before the request returns, so
            // the chart usually has its marks on the first frame. One small
            // JSON read on the ledger TTL — deliberately NOT wired into
            // `LiveStore`, which re-renders on every streamed tick. And
            // `loadIfNeeded`, not `load`: this `.task` re-runs on every
            // reselection of the tab, and a journal inside its TTL is not
            // worth a request per tap.
            await journal?.loadIfNeeded()
        }
        // The chart is scoped like the list is. It reloads rather than
        // filtering in place: a different scope is a different series, and the
        // server is the only thing that can sum one.
        .onChange(of: store.selectedScopeID) { _, scope in
            chart?.scopeChanged(to: scope)
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.bootstrap == nil {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.refresh() }
            }
        } else {
            loaded
        }
    }

    private var loaded: some View {
        VStack(spacing: 0) {
            StaleBar(freshness: store.freshness)

            // A sibling of the ScrollView, which is what keeps it pinned
            // while the summary and the chart scroll away — and what keeps
            // it clear of the pull-to-refresh gesture below. The manage menu
            // shows only with a portfolio selected — "All" is the daily
            // glance and carries no management chrome, the web's rule
            // verbatim.
            HoldingsHeaderBand(
                chips: store.scopeChips,
                selected: store.selectedScopeID,
                onSelect: { store.selectedScopeID = $0 },
                onCreate: portfolios == nil ? nil : { naming = .create },
                sort: sort,
                onSort: { picked in
                    sort = picked
                    picked.remember(for: .holdings)
                },
                manageScope: portfolios == nil ? nil : store.selectedPortfolio,
                ordered: store.orderedPortfolioIDs,
                isBusy: portfolios?.isBusy ?? false,
                onRename: {
                    guard let scope = store.selectedPortfolio else { return }
                    naming = .rename(scope)
                },
                onMove: { delta in
                    guard let portfolios, let scope = store.selectedPortfolio else { return }
                    Task {
                        let ordered = store.orderedPortfolioIDs
                        if await portfolios.move(id: scope.id, by: delta, within: ordered) {
                            await store.refresh()
                        }
                    }
                },
                onDelete: {
                    guard let portfolios, let scope = store.selectedPortfolio else { return }
                    Task {
                        if await portfolios.delete(id: scope.id) {
                            // The scope being looked at no longer exists.
                            // "All" is the only honest place to land, and
                            // a stale selection must never render.
                            store.selectedScopeID = LiveStore.allScopeID
                            await store.refresh()
                        }
                    }
                }
            )

            ScrollView {
                LazyVStack(spacing: 8) {
                    // Market state first, summary second: whether the figures
                    // are moving decides how much the figures mean.
                    if let market = store.live?.market {
                        MarketStatusBar(market: market)
                    }

                    if let summary = store.visibleSummary {
                        SummaryHeader(summary: summary)
                    }

                    if let chart {
                        PortfolioChartSection(store: chart, trades: scopedTrades)
                    }

                    // Transactions, Dividends, Analytics and News live here
                    // rather than in the tab bar for the same reason they
                    // light no tab on the web: all four slots are taken, and
                    // what you bought, what it paid, how it performed and
                    // what is being written about it all belong next to what
                    // you hold. One compact row, so the first holding is a
                    // swipe away instead of several.
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 70), spacing: 8)],
                        spacing: 8
                    ) {
                        ForEach(HoldingsNavDestination.allCases, id: \.self) { destination in
                            NavigationLink(value: destination.route) {
                                NavTile(
                                    title: destination.title,
                                    systemImage: destination.systemImage
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.bottom, 4)

                    ForEach(sortedHoldings, id: \.instrumentId) { holding in
                        let statics = store.staticHolding(for: holding)
                        if let symbol = statics?.symbol {
                            // A value-based link, so the destination is built by
                            // whoever owns the navigation stack. This view stays
                            // free of the auth store, which is what keeps it
                            // constructible in a test from a fake `LiveStore`.
                            NavigationLink(value: Route.instrument(symbol)) {
                                HoldingCard(holding: holding, statics: statics)
                            }
                            .buttonStyle(.plain)
                        } else {
                            // No symbol means no instrument screen to open — the
                            // static half has not arrived. Better an inert card
                            // than a link into a 404.
                            HoldingCard(holding: holding, statics: statics)
                        }
                    }

                    switch store.holdingsEmptiness {
                    case .notEmpty:
                        EmptyView()
                    case .accountEmpty:
                        EmptyState(
                            title: "No holdings yet",
                            explanation: "Record a transaction and your holdings will appear here.",
                            action: makeTransactionForm != nil ? .init(
                                label: "Add a transaction",
                                run: { isAddingTransaction = true }
                            ) : nil
                        )
                        .padding(.top, 48)
                    case let .scopeEmpty(portfolioName):
                        EmptyState(
                            title: "Nothing in \(portfolioName)",
                            explanation: "Your holdings are in another portfolio.",
                            action: makeTransactionForm != nil ? .init(
                                label: "Add a transaction",
                                run: { isAddingTransaction = true }
                            ) : nil,
                            secondaryAction: makeTransactionForm != nil ? .init(
                                label: "Show all holdings",
                                run: { store.selectedScopeID = LiveStore.allScopeID }
                            ) : nil
                        )
                        .padding(.top, 48)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            // Pull to refresh stays available even when the cadence is off,
            // because "the market is closed" is exactly when a user distrusts
            // a stale number and wants to force the question.
            .refreshable { await store.refresh() }
        }
        .sheet(item: $naming) { sheet in
            namingSheet(sheet)
        }
        .sheet(isPresented: $isAddingTransaction) {
            if let makeTransactionForm {
                TransactionFormView(
                    store: makeTransactionForm(),
                    onSaved: {
                        Task {
                            await store.refresh()
                            // The journal is on the ledger TTL — a fortnight —
                            // so without this the trade just recorded gets no
                            // marker on the chart whose LINE has already moved
                            // to include it.
                            journal?.invalidate()
                            await journal?.load()
                        }
                    },
                    imports: imports
                )
            }
        }
        .alert(
            portfolios?.errorMessage ?? "",
            isPresented: .init(
                get: { naming == nil && portfolios?.errorMessage != nil },
                set: { if !$0 { portfolios?.dismissError() } }
            )
        ) {
            Button("OK", role: .cancel) { portfolios?.dismissError() }
        }
    }

    /// Which naming question is being asked. `Identifiable` so it can drive
    /// `.sheet(item:)`, which is what keeps the sheet's initial text correct —
    /// a `.sheet(isPresented:)` would build the view before the target was set.
    fileprivate enum NamingSheet: Identifiable, Equatable {
        case create
        case rename(ScopeChip)

        var id: String {
            switch self {
            case .create: "create"
            case let .rename(scope): "rename-\(scope.id)"
            }
        }
    }

    @ViewBuilder
    private func namingSheet(_ sheet: NamingSheet) -> some View {
        if let portfolios {
            switch sheet {
            case .create:
                PortfolioNameSheet(
                    title: "New portfolio",
                    confirmLabel: "Create",
                    isBusy: portfolios.isBusy,
                    errorMessage: portfolios.errorMessage,
                    onSubmit: { name in
                        Task {
                            guard let id = await portfolios.create(name: name) else { return }
                            naming = nil
                            await store.refresh()
                            // Land ON the portfolio just made — the id is the
                            // server's, so this can never select the wrong chip
                            // when two share a name.
                            store.selectedScopeID = id
                        }
                    },
                    onCancel: {
                        portfolios.dismissError()
                        naming = nil
                    }
                )

            case let .rename(scope):
                PortfolioNameSheet(
                    title: "Rename portfolio",
                    confirmLabel: "Save",
                    initialName: scope.name,
                    isBusy: portfolios.isBusy,
                    errorMessage: portfolios.errorMessage,
                    onSubmit: { name in
                        Task {
                            guard await portfolios.rename(id: scope.id, to: name) else { return }
                            naming = nil
                            await store.refresh()
                        }
                    },
                    onCancel: {
                        portfolios.dismissError()
                        naming = nil
                    }
                )
            }
        }
    }
}

extension HoldingsView {
    /// The journal's rows, narrowed to whatever the chips have selected.
    ///
    /// "All" carries every trade; a single portfolio carries only its own,
    /// because the series under the markers is that portfolio's alone and a
    /// mark from another one would sit on a line it never contributed to.
    fileprivate var scopedTrades: [TradeMark] {
        guard let journal else { return [] }
        return TradeMark.from(HoldingsView.scoped(journal.rows, to: store.selectedScopeID))
    }

    /// The scope predicate, pure and separate so it can be pinned by a test
    /// without a chart, a store or a screen.
    ///
    /// `nil` is ALL, exactly as `PortfolioChartStore.scopeChanged` reads it.
    /// `LiveStore.selectedScopeID` is nil until `start()` restores the
    /// remembered chip, and treating that as "the portfolio whose id is nil"
    /// would draw the all-portfolios series with zero markers on it for every
    /// frame before the restore.
    static func scoped(_ rows: [TransactionRow], to scope: String?) -> [TransactionRow] {
        guard let scope, scope != LiveStore.allScopeID else { return rows }
        return rows.filter { $0.portfolioId == scope }
    }

    /// Sorted in the SAME pass that reads the store, on RAW decimal keys —
    /// the formatted pl-PL strings never reach the comparator, which could
    /// only compare them by the parse-back non-negotiable #1 forbids.
    fileprivate var sortedHoldings: [LiveHolding] {
        sortHoldings(store.visibleHoldings, by: sort) { holding in
            HoldingSortKeys(
                symbol: store.staticHolding(for: holding)?.symbol ?? "",
                valueRaw: holding.valuePLNRaw,
                profitRaw: holding.unrealizedPLNRaw
            )
        }
    }
}
