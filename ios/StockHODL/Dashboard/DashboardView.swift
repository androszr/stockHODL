import SwiftUI

/// The Dashboard: the whole portfolio's mood in one glance — market bar,
/// totals, and a dense grid of one small tile per holding.
///
/// It reads the SAME `LiveStore` the Holdings tab reads, and that is the whole
/// design. On the web these are two routes and App Router mounts one at a
/// time; here both tabs are alive at once, so a second store would mean a
/// second SSE connection delivering figures the app already has. For the
/// HOLDINGS data this view therefore owns nothing, starts no pump and issues
/// no request — `HoldingsView` owns that lifecycle and this one only renders.
///
/// Two stores are the sanctioned exception, and for the same reason each
/// time: the options strip and the market index strip both draw data no other
/// tab is guaranteed to have fetched, and the Dashboard may be the first tab
/// visited. Each is started from the `.task` below, and `start()` re-arms one
/// pump rather than adding a second, so a tab calling it as well is safe.
///
/// Scope: the Dashboard shows EVERY portfolio, ignoring the Holdings scope
/// chips, exactly as the web Dashboard does. A scoped dashboard would answer a
/// narrower question than the one its name asks, and would silently disagree
/// with the web under the same heading.
///
/// Deliberately no chart: the summary line is the only aggregate here (the
/// web's 2026-08-12 dashboard-ticker-grid decision).
struct DashboardView: View {
    let store: LiveStore
    /// The options strip's source — the SAME store the Options tab polls, so
    /// the two screens never disagree and the Dashboard adds no request of
    /// its own here either. Optional because the strip is absent until the
    /// store exists, and absent entirely for a book with no contracts.
    let options: OptionsStore?
    /// The index strip's source. Its own store and its own 60 s poll: the
    /// strip is a third PARALLEL delivery on the server too — SPY/QQQ/DIA
    /// never enter the holdings vendor batch or the socket subscription — and
    /// folding it into `LiveStore` would quietly undo that. Optional so this
    /// view stays constructible from fakes with no strip at all.
    let marketStrip: MarketStripStore?
    /// The "Day reports" history's source — a THIRD sanctioned store, for the
    /// same reason as the two above: no other tab fetches the history, and
    /// the Dashboard may be the first tab visited. Loaded from the `.task`
    /// below and refreshed with the pull. Optional so fakes stay constructible
    /// with no history at all.
    let dayReportHistory: DayReportHistoryStore?
    /// Switches the shell to the Holdings tab — the extended-hours box's tap.
    /// The shell owns the tab selection, so this view only asks. Nil keeps
    /// the box a plain, untappable readout (fakes, previews).
    var onOpenHoldings: (() -> Void)? = nil

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The Dashboard's OWN remembered ordering — separate from the Holdings
    /// list's, because the two screens are asked different questions: a
    /// dashboard is scanned by size, a list is often read by name.
    @State private var sort = HoldingsSort.remembered(for: .dashboard)
    /// The strip's OWN remembered order, separate from the Options tab's.
    @State private var optionsSort = OptionsSort.remembered(for: .dashboard)

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        // The HOLDINGS store is deliberately not started here — `HoldingsView`
        // owns that lifecycle and this view only reads it. The OPTIONS store
        // is different: this may be the first tab visited, and the strip would
        // otherwise stay empty until the Options tab happened to be opened.
        // `start()` re-arms one pump rather than adding a second, so both tabs
        // calling it is safe. The MARKET STRIP is the same case with no other
        // tab to fall back on at all: nothing else in the app reads it.
        // The history list is independent of both strips, so it loads
        // alongside them rather than queueing behind two pumps.
        .task {
            async let strips: Void = {
                await options?.start()
                await marketStrip?.start()
            }()
            async let history: Void? = dayReportHistory?.load()
            _ = await (strips, history)
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.bootstrap == nil {
            // The strip survives a holdings failure. It has its own store, its
            // own payload and its own disk cache, so a dead holdings fetch
            // says nothing about whether the market's mood is knowable — and
            // this is the screen where that mood is the only thing left to
            // read.
            VStack(spacing: 12) {
                marketStripRow
                Spacer(minLength: 0)
                LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                    Task {
                        async let holdings: Void = store.refresh()
                        async let strip: Void? = marketStrip?.refresh()
                        _ = await (holdings, strip)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
        } else {
            loaded
        }
    }

    /// Above the totals and OUTSIDE the empty-state and failure branches: the
    /// market's mood is not conditional on owning anything, nor on the
    /// holdings fetch having worked. Absent until the first payload lands — a
    /// skeleton here would hold space above someone's money for a row that is
    /// decoration.
    @ViewBuilder
    private var marketStripRow: some View {
        if let marketStrip, !marketStrip.tiles.isEmpty {
            MarketIndexStrip(
                tiles: marketStrip.tiles,
                fx: marketStrip.fx,
                freshness: marketStrip.freshness
            )
        }
    }

    private var loaded: some View {
        ScrollView {
            LazyVStack(spacing: QuietDesign.Space.medium) {
                // The Dashboard reads `LiveStore` like Holdings does, and so
                // owes the same disclosure. It drew none: the tab that showed
                // the day's mood was the one tab that never admitted the mood
                // was yesterday's.
                StaleBar(freshness: store.freshness)

                if store.tiles.isEmpty {
                    empty
                } else {
                    if let summary = store.live?.summary {
                        SummaryHeader(summary: summary, title: "All portfolios · holdings")
                        // Only while a pre-market or after-hours session is
                        // live: the server sends the aggregate then and null
                        // otherwise, so the box vanishes at 09:30 and 20:00
                        // with no clock on the phone. The header above stays
                        // on the regular session.
                        if let extended = summary.extended {
                            // "live" only when the StaleBar above has nothing
                            // to disclose — the same freshness notion.
                            ExtendedSummaryBox(
                                extended: extended,
                                isFresh: !store.freshness.needsDisclosure,
                                onTap: onOpenHoldings
                            )
                        }
                    }
                }

                if let market = store.live?.market {
                    MarketStatusBar(market: market, compact: true)
                }
                marketStripRow

                if !store.tiles.isEmpty {
                    HStack {
                        QuietSectionHeading(title: "Holdings")
                        Spacer(minLength: 0)
                        SortMenu(selected: sort) { picked in
                            sort = picked
                            picked.remember(for: .dashboard)
                        }
                    }

                    grid
                }

                optionsSection
                dayReportHistorySection
            }
            .padding(.horizontal, QuietDesign.Space.page)
            .padding(.bottom, 24)
        }
        // Pull-to-refresh moves EVERY figure on the screen. The strip has its
        // own store, so leaving it out meant the one gesture that says "make
        // this current" left three of the numbers exactly as stale as they
        // were.
        // Concurrently, not in series: the two fetches are independent, and
        // `APIClient` allows each 20 s, so awaiting them one after the other
        // would pin the spinner for 40 s on a dead connection.
        .refreshable {
            async let holdings: Void = store.refresh()
            async let strip: Void? = marketStrip?.refresh()
            async let history: Void? = dayReportHistory?.refresh()
            _ = await (holdings, strip, history)
        }
    }

    /// The tile GRID: `.adaptive` packs as many columns as fit (four on
    /// every supported iPhone at default text size), so a whole book reads
    /// in one glance. Accessibility text sizes widen the column minimum
    /// rather than squeezing large type into a 76 pt cell.
    private var tileColumns: [GridItem] {
        TileGrid.columns(isAccessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }

    private var grid: some View {
        LazyVGrid(columns: tileColumns, spacing: QuietDesign.Space.small) {
            ForEach(sorted, id: \.statics.instrumentId) { row in
                NavigationLink(value: Route.instrument(row.statics.symbol)) {
                    TickerGridTile(
                        symbol: row.statics.symbol,
                        displayName: row.statics.displayName,
                        price: row.live?.price,
                        cachedPrice: row.live?.cachedPrice,
                        dayPct: row.live?.dayPct,
                        extended: row.live?.extended,
                        // Same '—'/neutral fallbacks the Holdings card takes
                        // when a holding has no live figures yet.
                        unrealizedPct: row.live?.unrealizedPct ?? "—",
                        direction: row.live?.direction ?? .neutral,
                        // From the STATIC half: a trend changes once a day,
                        // and this is the half that survives a tick.
                        trend: row.statics.trend
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Sorted in the SAME pass that reads the store, on RAW decimal keys only
    /// — the formatted strings never reach the comparator (non-negotiable #1).
    private var sorted: [LiveStore.DashboardTile] {
        sortHoldings(store.tiles, by: sort) { row in
            HoldingSortKeys(
                symbol: row.statics.symbol,
                valueRaw: row.live?.valuePLNRaw,
                profitRaw: row.live?.unrealizedPLNRaw
            )
        }
    }

    /// The Dashboard's options strip.
    ///
    /// Rendered only when unexpired contracts exist, so a zero-contract
    /// dashboard is identical to one that never knew about options — no
    /// orphan heading. The FINANCIAL isolation stands: the total below is USD
    /// and is never summed with the złoty summary above it. Two currencies,
    /// two labelled sections, never one figure.
    ///
    /// `options` is a SEPARATE store from `store` (Holdings/`LiveStore`), with
    /// its own request — so Holdings loading first must not mean this section
    /// pops in seconds later once Options finally answers. While that first
    /// answer is in flight, a skeleton holds the section's place; only once it
    /// resolves does this collapse to nothing (truly no contracts) or the
    /// real strip.
    @ViewBuilder
    private var optionsSection: some View {
        if let options, options.isLoading, options.payload == nil {
            OptionsSectionSkeleton()
        } else if let options, !visibleOptions.isEmpty {
            VStack(alignment: .leading, spacing: QuietDesign.Space.medium) {
                // The options book gets the SAME box the holdings total has —
                // value, today, total, five-session lights — above its grid,
                // in place of the inline figure the header used to carry
                // (2026-09-21). USD, and never summed into the złoty box.
                if let summary = options.payload?.summary {
                    SummaryHeader(
                        summary: summary,
                        title: "Options value",
                        accessibilityName: "Options summary"
                    )
                    .padding(.bottom, 8)
                }

                HStack {
                    QuietSectionHeading(title: "Options")
                    Spacer(minLength: 0)
                    SortMenu(selected: optionsSort) { picked in
                        optionsSort = picked
                        picked.remember(for: .dashboard)
                    }
                }

                LazyVGrid(columns: tileColumns, spacing: QuietDesign.Space.small) {
                    ForEach(visibleOptions, id: \.key) { item in
                        NavigationLink(value: Route.optionContract(item.key)) {
                            OptionTile(item: item)
                        }
                        .buttonStyle(.plain)
                    }
                }

                // The row's own disclosure — it had none, so an options
                // figure could be a day old with nothing on screen saying so.
                // The same caption the index tiles above draw, and NOT a
                // second `StaleBar`: this screen already carries the holdings'
                // full-width bar, and two of those read as two alarms for one
                // condition.
                StaleCaption(freshness: options.freshness)
            }
            .padding(.top, 12)
        }
    }

    /// The "Day reports" history, under everything else: it is the one part
    /// of this screen that is about the past rather than now. Absent only
    /// when no store was handed in (fakes); with a store, the section itself
    /// draws its skeleton, empty line, failure block or list.
    @ViewBuilder
    private var dayReportHistorySection: some View {
        if let dayReportHistory {
            DayReportHistorySection(store: dayReportHistory)
        }
    }

    /// The Options tab's hide rule, verbatim — a contract must not vanish from
    /// one screen while lingering on the other. No reveal toggle here: tiles
    /// carry no manage menu, so the Dashboard is not a reachability route.
    private var visibleOptions: [OptionCardItem] {
        guard let options, let payload = options.payload else { return [] }
        return sortOptionCards(payload.items.filter { !$0.expired }, by: optionsSort)
    }

    private var empty: some View {
        EmptyState(
            title: "No positions yet",
            explanation: "Add a transaction and it will show up here, aggregated per ticker."
        )
        .padding(.top, 48)
    }
}

/// Holds the options strip's place while its first response is in flight —
/// same title row, same tile grid shape, filled with pulsing placeholders
/// instead of real figures. Four tiles: not a claim about how many contracts
/// exist, just enough to read as "a grid is coming" rather than as a stray
/// decoration.
private struct OptionsSectionSkeleton: View {
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text("Options")
                    .font(.system(.subheadline, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
                Spacer(minLength: 8)
                block(width: 64, height: 14)
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 76), spacing: 8)],
                spacing: 8
            ) {
                ForEach(0..<4, id: \.self) { _ in
                    block(height: 76)
                }
            }
            .padding(.top, 8)
        }
        .padding(.top, 12)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }

    private func block(width: CGFloat? = nil, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color(Tokens.surface1))
            .frame(width: width, height: height)
            .opacity(pulse ? 0.5 : 1)
    }
}
