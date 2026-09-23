import SwiftUI

/// ONE tracked contract's screen — the counterpart of the instrument screen on
/// the options side, reached from a card's headline.
///
/// The card is found inside the user's OWN already-loaded payload, never
/// fetched by key: the tab's poll is the only request, so opening a contract
/// costs nothing and no figure is computed twice. A key that is not in the
/// payload renders the "no longer tracked" state rather than an error — the
/// realistic cause is the contract having been removed on the web while this
/// screen sat in a navigation stack.
///
/// The card renders in its `detail` variant: the header here already carries
/// the identity, so the card drops its headline and the link to where we
/// already are. Everything else — the ⋯ menu, the figures, the greeks — is
/// the same view, so the two surfaces cannot drift.
struct OptionContractView: View {
    let store: OptionsStore
    let cardKey: String
    /// Threaded to the add sheet. Optional so this view stays constructible
    /// from fakes alone.
    var imports: ImportStore?
    let makeFormStore: (OptionFormStore.Mode) -> OptionFormStore

    @State private var form: OptionFormStore?
    @State private var pendingRemoval: OptionLotItem?
    /// The whole-book series is what the tab shows; this screen wants THIS
    /// contract's own. Kept locally so navigating back does not leave the tab
    /// charting one contract.
    @State private var series: SeriesPayload?
    /// The range `series` was fetched for — the same guard `OptionsStore`
    /// keeps, so a tapped tab never shows the old window's change under the
    /// new window's name while its own fetch is in flight.
    @State private var seriesRange: OptionsChartRange?
    /// Scoped to a range like the store's: another tab is loading, not failed.
    @State private var failedRange: OptionsChartRange?

    /// The STORE's range, like the mode: one contract and the whole book are
    /// the same question at two scales. This screen used to keep its own
    /// copy and write the shared remembered key behind the store's back,
    /// which left the tab's in-memory range and its cached series disagreeing
    /// with what the next launch read back.
    private var range: OptionsChartRange { store.range }

    private var seriesState: ChartState {
        if failedRange == range { return .error }
        guard let series, seriesRange == range else { return .loading }
        return series.points.isEmpty ? .empty : .ready
    }

    private var item: OptionCardItem? { store.card(forKey: cardKey) }

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
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
            Button("Remove \(lot.tradeDateLabel) · \(lot.quantity) @ \(lot.entryPrice)",
                   role: .destructive) {
                let id = lot.id
                pendingRemoval = nil
                Task { await store.remove(lotID: id) }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        }
        .task(id: cardKey) { await loadSeries() }
        .onChange(of: store.range) { _, _ in
            // Remembered by the store's own `didSet`; this screen only
            // fetches its contract's series for the new window.
            failedRange = nil
            Task { await loadSeries() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let item {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header(item)
                    chart
                    OptionCardView(
                        item: item,
                        variant: .detail,
                        onEdit: { form = makeFormStore(.edit($0)) },
                        onRemove: { pendingRemoval = $0 }
                    )
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        } else {
            VStack(spacing: 6) {
                Text("Not tracked any more")
                    .font(.system(.body, weight: .medium))
                    .foregroundStyle(Color(Tokens.textPrimary))
                Text("This contract was removed. Go back to see what you still hold.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
            .padding(32)
        }
    }

    private func header(_ item: OptionCardItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // The underlying is the one word here that names another screen —
            // a link, not plain text, so a contract's page is never a dead
            // end for "what's the stock itself doing."
            NavigationLink(value: Route.instrument(item.underlying)) {
                Text("\(item.underlying) $\(item.strikeLabel) \(item.contractType == .call ? "CALL" : "PUT")")
                    .font(.system(.title3, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
            }
            .buttonStyle(.plain)
            Text(item.ticker)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(Color(Tokens.textMuted))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    private var chart: some View {
        VStack(spacing: 4) {
            ValueChart(
                points: series?.points ?? [],
                state: seriesState,
                granularity: range.granularity,
                currency: "USD",
                excludedSymbols: series?.excludedSymbols ?? [],
                partialDays: series?.partialDays ?? 0,
                estimatedFrom: series?.estimatedFrom,
                emptyMessage: "No recorded marks for this range yet.",
                unit: store.chartMode == .percentReturn ? .percent : .money,
                mode: store.chartMode,
                windowLabel: range.windowLabel,
                // This contract's own lots only — the line is this contract's.
                trades: TradeMark.fromLots(item.map { [$0] } ?? [])
            )
            HStack(alignment: .center, spacing: 8) {
                RangeTabs(selected: range) { store.range = $0 }
                // The SAME store's mode as the Options tab chart, deliberately:
                // one contract and the whole book are the same question asked
                // at two scales, and a per-screen answer would make the toggle
                // forget itself on every push.
                ChartToggle(
                    selected: store.chartMode,
                    accessibilityName: "Chart mode"
                ) { store.chartMode = $0 }
                .fixedSize()
                .padding(.trailing, 16)
            }
        }
    }

    private func loadSeries() async {
        // The OCC TICKER, not the card key — a card can be a `ticker#rowId`
        // group, which matches no row on the server.
        guard let ticker = item?.ticker else { return }
        let wanted = range
        let fresh = await store.contractSeries(ticker: ticker, range: wanted)
        // Moved on while in flight — a later request owns the screen now.
        guard wanted == range else { return }
        if let fresh {
            series = fresh
            seriesRange = wanted
            failedRange = nil
        } else if seriesRange != wanted {
            // Nothing of this range's own to keep; the previous range's
            // chart cannot stand in for it.
            series = nil
            seriesRange = nil
            failedRange = wanted
        }
    }
}
