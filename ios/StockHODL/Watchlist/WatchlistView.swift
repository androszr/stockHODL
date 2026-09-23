import SwiftUI

/// Things being watched but not owned.
struct WatchlistView: View {
    let store: WatchlistStore
    /// Owned by the shell so the persistent top bar can open this sheet —
    /// the system toolbar that used to hold the plus is hidden.
    @Binding var isAdding: Bool
    /// Edit mode — a remove badge on every tile in place of its navigation.
    /// Owned by the shell for the same reason `isAdding` is: the Edit/Done
    /// toggle lives in the persistent top bar, above every stack.
    @Binding var isEditing: Bool
    /// The search sheet's own form store, injected for the same reason every
    /// other screen's is: this view names no auth store.
    let makeForm: () -> TransactionFormStore
    /// Open a stock's own screen. The shell owns the navigation path, so the
    /// sheet hands the symbol up rather than pushing anything itself.
    let onOpen: (String) -> Void
    /// Shared with the shell's magnifier door so both presentations of
    /// `SymbolSearchSheet` show the same recent lookups.
    let recents: RecentSymbolsStore

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle("Watchlist")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.start() }
        // When the last badge removes the last tile, the empty-state text
        // takes over and there is nothing left to edit — and the top bar's
        // `hasItems` gate has already hidden the Done button that would have
        // ended the mode.
        .onChange(of: store.items.isEmpty) { _, empty in
            if empty { isEditing = false }
        }
        .sheet(isPresented: $isAdding) {
            SymbolSearchSheet(
                form: makeForm(),
                recents: recents,
                onOpen: onOpen,
                onWatch: { match in Task { await store.add(match) } },
                // Read inside the sheet's body so the rows track the
                // `@Observable` store — a row flips to "Watching" when the
                // add lands, not only optimistically.
                isWatched: { symbol in store.items.contains { $0.symbol == symbol } }
            )
        }
        .alert(
            store.errorMessage ?? "",
            isPresented: .init(
                get: { store.errorMessage != nil && !store.items.isEmpty },
                set: { if !$0 { store.dismissError() } }
            )
        ) {
            Button("OK") { store.dismissError() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.items.isEmpty {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.items.isEmpty {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.refresh() }
            }
        } else if store.items.isEmpty {
            EmptyState(
                title: "Nothing on the watchlist",
                explanation: "Keep an eye on a stock without adding it to your holdings.",
                action: .init(
                    label: "Add a stock to watch",
                    run: { isAdding = true }
                )
            )
        } else {
            list
        }
    }

    private var list: some View {
        VStack(spacing: 0) {
            // The same bar Holdings draws, from the same `Freshness` — it
            // used to be an inline copy here saying "Figures may be out of
            // date" while Holdings said "Data from 17:02" about the identical
            // situation.
            StaleBar(freshness: store.freshness)
            rows
        }
    }

    /// The Dashboard's tile GRID, not a list — the same shape the web
    /// watchlist takes (`watchlist-live.tsx` renders `TickerTile` in the
    /// Dashboard's auto-fill grid, deliberately reusing that component).
    ///
    /// A watched stock is a ticker and a price; a full-width row spent the
    /// whole phone on two figures and showed four names per screen where the
    /// grid shows twenty. The stronger reason is drift: the same tickers
    /// appearing as tiles on the Dashboard and as rows here is two renderings
    /// of one idea, and the second one is the one that stops being maintained.
    private var rows: some View {
        ScrollView {
            // News sits above the tiles, as the section does on the web's
            // watchlist: the stories are about these symbols, and burying
            // them under a scroll of tiles is how a feed goes unread.
            NavigationLink(value: Route.news(nil)) {
                NavRow(title: "News", systemImage: "newspaper")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.top, 12)

            // The SECTION model, never `store.items`: the server sorted the
            // live payload by target proximity, and iterating the raw list
            // here would silently discard that order. Headers only exist
            // when some stock has a waiting line — an all-`none` watchlist
            // renders one unlabeled grid, exactly as before.
            VStack(spacing: 0) {
                ForEach(store.sections) { section in
                    if let title = section.title {
                        Text(title)
                            .font(.footnote)
                            .foregroundStyle(Color(Tokens.textSecondary))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.top, 12)
                            .accessibilityAddTraits(.isHeader)
                    }
                    grid(for: section)
                }
            }
            .padding(.bottom, 24)
        }
        .refreshable { await store.refresh() }
    }

    /// One section's tile grid. Edit-mode remove badges and the long-press
    /// menu stay attached per tile inside each section, unchanged.
    private func grid(for section: WatchlistSection) -> some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 76), spacing: 8)],
            spacing: 8
        ) {
                ForEach(section.items, id: \.instrumentId) { item in
                    if isEditing {
                        // The same tile, but its tap is gone: while badges
                        // are up the grid is about removal, and a cell that
                        // also navigated would make every badge a near-miss
                        // gamble.
                        tile(for: item)
                            .overlay(alignment: .topTrailing) {
                                Button {
                                    Task { await store.remove(item) }
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .font(.system(size: 22))
                                        .foregroundStyle(Color(Tokens.loss))
                                        // A surface-0 disc behind the glyph:
                                        // the minus cutout is transparent, and
                                        // without the backing it goes illegible
                                        // over the tile fill and the grid gap
                                        // alike.
                                        .background(Circle().fill(Color(Tokens.surface0)))
                                        // The glyph is ~22pt; the button's
                                        // frame is what meets the 44pt floor.
                                        .frame(width: 44, height: 44)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Stop watching \(item.symbol)")
                            }
                    } else {
                        NavigationLink(value: Route.instrument(item.symbol)) {
                            tile(for: item)
                        }
                        .buttonStyle(.plain)
                        // A grid has no swipe actions, so removal moves to the
                        // long press — the native gesture that replaces it. Kept
                        // rather than dropped to web parity: the web removes from
                        // the ticker page, one screen further away, and a list
                        // that could do it here should not lose that by changing
                        // shape.
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { await store.remove(item) }
                            } label: {
                                Label("Stop watching \(item.symbol)", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
    }

    /// One construction of the tile for both branches of the `ForEach` —
    /// the argument list is long enough that a second copy would drift.
    private func tile(for item: WatchedItem) -> some View {
        let figures = store.figures(for: item)
        return TickerTile(
            symbol: item.symbol,
            displayName: item.displayName,
            // No cached fallback exists on this payload —
            // `LiveWatchItem` carries none, exactly as the
            // web tile is handed none here.
            price: figures?.price,
            cachedPrice: nil,
            dayPct: figures?.dayPct,
            extended: figures?.extended,
            // Nothing is OWNED here, so the tile drops its
            // P/L line rather than printing "P/L —" about a
            // position that does not exist.
            unrealizedPct: nil,
            direction: .neutral,
            // The watchlist row carries its own strip — this
            // store never reads the bootstrap.
            trend: item.trend,
            // The proximity marker rides the free P/L slot: how far the
            // nearest line is, and which way the price would have to move.
            target: figures?.target
        )
    }
}
