import SwiftUI

/// The read-only screen behind a market tile: the headline figure, the day's
/// move and a full-size chart with the stock screen's range switcher and
/// line-or-candles toggle.
///
/// A screen for LOOKING, not for holding. There is deliberately no watch
/// control, no target line and no transaction button — an index or a currency
/// is not something you own, and the store behind this screen has nothing it
/// can write.
///
/// Two stores, two cadences, on purpose. The header reads the SAME
/// `MarketStripStore` the Dashboard polls — `tile(for:)` — so the figure
/// here is the figure on the tile the user just tapped, repainted on the
/// strip's cadence with no second quote fetch. The chart comes from
/// `MarketDetailStore`, per key and per range. The disclosure register is
/// the tile's: an index screen says `via SPY` under its title, the currency
/// screen says `PLN per 1 USD` — the number is never shown without what it
/// means.
struct MarketDetailView: View {
    let store: MarketDetailStore
    /// The Dashboard's strip store, nil only in the split second before the
    /// shell has built it; the header then draws the title alone.
    let strip: MarketStripStore?

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle(header?.title ?? fallbackTitle)
        .navigationBarTitleDisplayMode(.inline)
        // Keyed on the store's identity — see `InstrumentView` for why.
        .task(id: ObjectIdentifier(store)) { await store.load() }
    }

    private var header: MarketTileHeader? { strip?.tile(for: store.key) }

    /// What the title bar says before the strip has a payload: the key's own
    /// name, so the screen is never titled with an empty string.
    private var fallbackTitle: String { store.key.displayTitle }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerBlock

                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .center, spacing: 8) {
                        RangeTabs(selected: store.range) { store.range = $0 }
                            .padding(.leading, -16)

                        ChartToggle(
                            selected: store.style,
                            accessibilityName: "Chart style"
                        ) { store.style = $0 }
                        .fixedSize()
                    }

                    ValueChart(
                        points: store.points,
                        state: store.seriesState,
                        granularity: store.range.granularity,
                        currency: store.currency,
                        excludedSymbols: store.series?.excludedSymbols ?? [],
                        partialDays: store.series?.partialDays ?? 0,
                        emptyMessage: "No history for this range.",
                        unit: store.unit,
                        style: store.style,
                        windowLabel: store.range.windowLabel
                    )
                }
            }
            .padding(16)
        }
        .refreshable {
            // Both halves: the header's figure and the chart. The strip's
            // refresh is the same request the Dashboard makes.
            async let chart: Void = store.load()
            async let tile: Void? = strip?.refresh()
            _ = await (chart, tile)
        }
    }

    @ViewBuilder
    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The strip's freshness, not the chart's: it is the strip's
            // figure that sits here. Same wording as under the tile row.
            if let strip {
                StaleCaption(freshness: strip.freshness)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(header?.title ?? fallbackTitle)
                    .font(.system(.title3, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))

                // The disclosure — never conditional. An index screen names
                // the fund the number came from; the currency screen says
                // what the number means.
                if let caption = header?.caption {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(header?.last ?? "—")
                    .font(.system(.title2, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))

                if header?.last != nil, let day = header?.dayPct {
                    // The sign is the non-colour carrier of direction — the
                    // server's `fmtPct` writes it.
                    Text(day.text)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(Color(day.direction.token))
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    /// One sentence: what it is, what the figure means, the reading and the
    /// day's move — the tile's four facts in the tile's order.
    private var accessibilityLabel: String {
        let title = header?.title ?? fallbackTitle
        let caption = header?.caption ?? ""
        let level = header?.last ?? "no reading"
        let move = header?.dayPct.map { "\($0.text) today" } ?? "no change figure today"
        return caption.isEmpty ? "\(title), \(level), \(move)" : "\(title), \(caption), \(level), \(move)"
    }
}

extension MarketTileKey {
    /// The tile's title as the strip prints it — what the top bar and the
    /// screen fall back to before the strip's payload names it. Kept in step
    /// with `INDEX_PROXIES` / `FX_PAIR_LABEL` on the server; the payload's
    /// own `indexName` / `pairLabel` wins whenever it is present.
    var displayTitle: String {
        switch self {
        case .spy: "S&P 500"
        case .qqq: "Nasdaq"
        case .dia: "Dow"
        case .usdpln: "USD/PLN"
        }
    }
}
