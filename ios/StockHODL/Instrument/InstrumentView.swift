import SwiftUI

/// One instrument: price, chart, position, and the transactions behind it.
///
/// Every figure here is a server-formatted string, for the same reason the
/// holding card's are — the money pipeline ends at the server, and re-deriving
/// a display value on a device that cannot be trusted with `Double` would be a
/// second rounding implementation. The only numbers this file computes are
/// chart coordinates, and those come through `PlotPoints`.
struct InstrumentView: View {
    let store: InstrumentStore
    /// Builds the prefilled add-transaction form. Absent in previews and
    /// tests, and then the button simply is not drawn — this screen has never
    /// needed a network to be constructible and that must not change here.
    /// The hoisted transaction journal, the same one the Holdings chart's
    /// markers read. Held here only so a trade recorded on THIS screen shows
    /// up as a marker over there without waiting out the ledger TTL. Optional
    /// like the form builder, so this screen still builds from fakes alone.
    var journal: TransactionsStore?
    var makeTransactionForm: (() -> TransactionFormStore)?

    @State private var isAddingTransaction = false
    @State private var isSettingTarget = false
    @State private var pendingRemoval: TransactionRow?

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle(store.symbol)
        .navigationBarTitleDisplayMode(.inline)
        // Keyed on the store's IDENTITY, not on nothing: a bare `.task` runs
        // once per view identity, so a screen handed a different store
        // instance after it appeared — the shell re-evaluating its
        // `navigationDestination` closure — would keep rendering that new,
        // empty store and never load it. The shell no longer does that (see
        // `RouteStores`), and this makes it harmless if anything ever does
        // again.
        .task(id: ObjectIdentifier(store)) { await store.load() }
        .sheet(isPresented: $isAddingTransaction) {
            if let makeTransactionForm {
                TransactionFormView(
                    store: prefilled(makeTransactionForm()),
                    onSaved: {
                        Task {
                            await store.load()
                            // Same reason as the Holdings add sheet: the
                            // journal's fortnight-long TTL would otherwise keep
                            // this trade off the Holdings chart long after the
                            // line moved for it.
                            journal?.invalidate()
                            await journal?.load()
                        }
                    }
                )
            }
        }
        .sheet(isPresented: $isSettingTarget) {
            PriceTargetSheet(store: store)
        }
        .confirmationDialog(
            "Delete this transaction?",
            isPresented: .init(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingRemoval
        ) { row in
            Button(
                "Delete \(TransactionLine.quantityAtPrice(row))",
                role: .destructive
            ) {
                pendingRemoval = nil
                Task {
                    await store.deleteTransaction(row)
                    // The mirror of the add path above. Without this the
                    // deleted trade keeps its marker on the Holdings chart
                    // until the journal's fortnight-long TTL lapses — a mark
                    // on the line for a trade that no longer exists.
                    journal?.invalidate()
                    await journal?.load()
                }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        }
        .alert(
            store.errorMessage ?? "",
            isPresented: .init(
                // Only over a painted screen: the empty-state branch already
                // renders the message with a Try again beside it, and an
                // alert on top of it would say the same thing twice.
                get: { store.errorMessage != nil && store.detail != nil },
                set: { if !$0 { store.dismissError() } }
            )
        ) {
            Button("OK") { store.dismissError() }
        }
    }

    /// Seed the form with THIS instrument — the phone's `?symbol=` deep link.
    ///
    /// Through `prefill` rather than the initialiser, so the FX lookup fires
    /// exactly as it would after picking the same instrument out of the
    /// combobox. Every field comes from the server's own row for the symbol,
    /// which matters: `instruments` is global and first-write-wins, so a
    /// guessed currency would bind it permanently.
    private func prefilled(_ form: TransactionFormStore) -> TransactionFormStore {
        guard let detail = store.detail else { return form }
        form.prefill(
            symbol: detail.symbol,
            displayName: detail.displayName,
            exchange: detail.exchange,
            currency: detail.currency
        )
        return form
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.detail == nil {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if store.isMissing {
            // Nothing to retry: the server said this instrument is not one of
            // yours, and asking again will say the same.
            Text("We don't have this instrument for you.")
                .font(.subheadline)
                .foregroundStyle(Color(Tokens.textSecondary))
                .padding(24)
        } else if store.detail == nil, let seed = store.seed {
            // The header the app already had, rather than an apology. Reached
            // when this stock has never been opened on this device AND the
            // server cannot be asked — the one gap the on-disk cache cannot
            // fill, and the common one: the row that was tapped came from a
            // payload that knew the name and the price.
            SeededHeader(
                seed: seed,
                freshness: store.freshness,
                retry: { Task { await store.load() } }
            )
        } else if let message = store.errorMessage, store.detail == nil {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.load() }
            }
        } else {
            loaded
        }
    }

    private var loaded: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // The screen owes the same disclosure the tabs do — it draws
                // prices, and until now it drew them from a cache without ever
                // saying so.
                StaleBar(freshness: store.freshness)
                    .padding(.horizontal, -16)

                header

                DayStatsPanel(stats: store.detail?.dayStats)

                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .center, spacing: 8) {
                        RangeTabs(selected: store.range) { store.range = $0 }
                            .padding(.leading, -16)

                        // Line or candles. Display-only where the data allows:
                        // `o`/`h`/`l` ride the same payload, and a range whose
                        // bars carry none falls back to the line inside
                        // `ValueChart` rather than drawing an empty frame.
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
                        emptyMessage: "No price history for this range.",
                        style: store.style,
                        windowLabel: store.range.windowLabel,
                        // Every portfolio's rows, like the list further down
                        // this screen: a price chart is about the instrument,
                        // not about which pot the shares sit in.
                        trades: TradeMark.from(store.transactions),
                        // The only surface where a trade's unit price and the
                        // plotted quantity are the same kind of number.
                        matchOnPrice: true
                    )
                }

                if let position = store.position {
                    PositionPanel(position: position)
                }

                // Visible for a stock the user holds or watches, and for any
                // stock that still CARRIES targets — a target on a since-
                // unwatched stock must stay deletable. The Set target button
                // needs owned-or-watched, matching the server's 409.
                if let detail = store.detail,
                   detail.owned || store.isWatched || !store.priceTargets.isEmpty {
                    PriceTargetsSection(
                        targets: store.priceTargets,
                        status: store.targetStatus,
                        currency: store.currency,
                        canSetTarget: detail.owned || store.isWatched,
                        deletingIds: store.deletingTargetIds,
                        onSetTarget: { isSettingTarget = true },
                        onDelete: { target in
                            Task { await store.deleteTarget(target) }
                        }
                    )
                }

                if store.groups.count > 1 {
                    // Shown only when the position is actually SPLIT. One
                    // portfolio's breakdown is the position again, restated.
                    GroupBreakdown(groups: store.groups)
                }

                AboutPanel(about: store.detail?.about, currency: store.currency)

                TransactionsPanel(rows: store.transactions, onRemove: { pendingRemoval = $0 })

                links
            }
            .padding(16)
        }
        .refreshable { await store.load() }
    }

    @ViewBuilder
    private var header: some View {
        if let detail = store.detail {
            VStack(alignment: .leading, spacing: 6) {
                // The bigger tile, four monogram chars — the web header's
                // sizing, because this is the one screen with room for it.
                HStack(spacing: 12) {
                    TickerLogo(symbol: detail.symbol, size: 48, monogramChars: 4)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(detail.displayName)
                            .font(.system(.title3, weight: .semibold))
                            .foregroundStyle(Color(Tokens.textPrimary))

                        Text("\(detail.symbol) · \(detail.exchange) · \(detail.currency.rawValue)")
                            .font(.caption)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }

                    Spacer(minLength: 0)
                }

                // The outer row is .center, not .firstTextBaseline,
                // deliberately: baseline-aligning a 44pt button against a
                // title2 price sinks it below the row. The price/day pair
                // keeps its own baseline alignment inside.
                HStack(alignment: .center, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        // Live price first; else the last SAVED price, muted,
                        // with its fetch instant labelled "cached" below —
                        // display-only, and no figure on this screen is ever
                        // priced from it; else the honest dash. The web
                        // header's ladder verbatim.
                        Text(detail.price ?? detail.cachedPrice?.text ?? "—")
                            .font(.system(.title2, weight: .semibold))
                            .monospacedDigit()
                            .foregroundStyle(
                                Color(detail.price == nil && detail.cachedPrice != nil
                                    ? Tokens.textMuted
                                    : Tokens.textPrimary)
                            )

                        if detail.price != nil, let day = detail.dayPct {
                            Text(day.text)
                                .font(.subheadline)
                                .monospacedDigit()
                                .foregroundStyle(Color(day.direction.token))
                        }
                    }

                    Spacer(minLength: 8)

                    InstrumentActionButtons(
                        model: .current(
                            isWatched: store.isWatched,
                            isToggling: store.isTogglingWatch
                        ),
                        showsAddTransaction: makeTransactionForm != nil,
                        onToggleWatch: { Task { await store.toggleWatch() } },
                        onAddTransaction: { isAddingTransaction = true }
                    )
                }

                if detail.price == nil, let cached = detail.cachedPrice {
                    // A FETCH time, worded as one. It is never presented as a
                    // trade time, because nothing here knows when the trade was.
                    Text("cached · \(InstrumentView.cachedTime(cached.asOfMs))")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textMuted))
                }

                if let extended = detail.extended {
                    // Pre- and post-market is a separate fact from the regular
                    // session's move. Folding them together would misreport both.
                    ExtendedMoveView(extended: extended, variant: .full)
                }
            }
        }
    }
}

// MARK: - Actions and links

extension InstrumentView {
    /// This stock's news and its dividends.
    ///
    /// Links rather than embedded sections, deliberately: both are their own
    /// endpoints and their own screens, and folding either into this payload
    /// would make every instrument open pay for data a user may never scroll
    /// to. The web embeds them because a page load is one round trip; a phone
    /// screen is not.
    @ViewBuilder
    fileprivate var links: some View {
        if let detail = store.detail {
            VStack(spacing: 8) {
                NavigationLink(value: Route.news(detail.symbol)) {
                    NavRow(title: "News · \(detail.symbol)", systemImage: "newspaper")
                }
                .buttonStyle(.plain)

                // Shown only when the instrument actually HAS a dividend
                // payment. `owned` alone isn't enough — a held stock that has
                // never paid one is still a dead end, same as a watched one.
                if detail.hasDividends {
                    NavigationLink(value: Route.dividends(detail.symbol)) {
                        NavRow(title: "Dividends", systemImage: "banknote")
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// The cached price's fetch instant, on the DEVICE's clock and in the
    /// app's one locale — the `CachedAsOf` rule, which is why epoch ms crosses
    /// the wire raw rather than pre-formatted.
    static func cachedTime(_ ms: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            .formatted(
                .dateTime.day().month(.abbreviated).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
                    .locale(ChartLabels.locale)
            )
    }
}

// MARK: - Day stats

/// The Yahoo-style session row — previous close, open, day range, volume and
/// VWAP.
///
/// Every value arrives PRE-FORMATTED from `dayStatsFigures`, the same function
/// the web's `DayStats` renders through, so the two rows cannot round
/// differently or disagree about what an absent field looks like. A null is
/// an em dash, never a fabricated zero: a stock that has not opened has no
/// open, and "0,00" would be a claim rather than a gap.
///
/// Two columns rather than the web's five-across: five monospaced money
/// figures do not fit a phone's width, and the web itself only goes to five
/// from `sm:` up.
private struct DayStatsPanel: View {
    let stats: DayStats?

    private var range: String {
        guard let low = stats?.dayLow, let high = stats?.dayHigh else { return "—" }
        return "\(low) – \(high)"
    }

    var body: some View {
        Panel(title: "Day") {
            LazyVGrid(
                columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)],
                alignment: .leading,
                spacing: 10
            ) {
                cell("Prev close", stats?.prevClose)
                cell("Open", stats?.dayOpen)
                cell("Day range", range)
                cell("Volume", stats?.volume)
                cell("Avg (VWAP)", stats?.vwap)
            }
        }
    }

    private func cell(_ label: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
            Text(value ?? "—")
                .font(.caption)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(Color(Tokens.textPrimary))
        }
    }
}

// MARK: - Position

/// What the user holds, when they hold any of it.
private struct PositionPanel: View {
    let position: PositionFigures

    var body: some View {
        Panel(title: "Position") {
            FigureRow(label: "Quantity", value: position.quantity)
            FigureRow(label: "Average cost", value: position.avgCost ?? "—")
            FigureRow(label: "Cost basis", value: position.costBasisPLN)
            FigureRow(label: "Value", value: position.valuePLN ?? "—")
            FigureRow(
                label: "Unrealized",
                value: position.unrealizedPLN ?? "—",
                secondary: position.unrealizedPct,
                direction: position.direction
            )
            if position.oversold {
                // The server's verdict that more was sold than was ever bought.
                // Shown, not silently corrected: the fix is a missing
                // transaction, and only the user knows which one.
                Text("Sold more than was bought — a transaction is missing.")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.loss))
            }
        }
    }
}

/// The same position, per portfolio.
private struct GroupBreakdown: View {
    let groups: [PortfolioGroup]

    var body: some View {
        Panel(title: "By portfolio") {
            ForEach(groups, id: \.portfolioId) { group in
                FigureRow(
                    label: group.portfolioName,
                    value: group.summary.valuePLN ?? "—",
                    secondary: group.summary.unrealizedPct,
                    direction: group.summary.direction
                )
            }
        }
    }
}

// MARK: - Transactions

private struct TransactionsPanel: View {
    let rows: [TransactionRow]
    /// Present when this surface can delete — absent in previews/tests, and
    /// then the row draws with no delete affordance at all, same convention
    /// as `makeTransactionForm` above.
    var onRemove: ((TransactionRow) -> Void)? = nil

    var body: some View {
        Panel(title: "Transactions") {
            if rows.isEmpty {
                Text("None yet.")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            } else {
                ForEach(rows, id: \.id) { row in
                    TransactionLine(row: row, onRemove: onRemove)
                }
            }
        }
    }
}

/// One transaction. Read-only apart from the trash button, which opens a
/// confirmation the caller owns (`InstrumentView`'s `confirmationDialog`) —
/// this view only ever reports WHICH row, never deletes on its own.
///
/// The amounts here are RAW decimal strings, not display text — the contract
/// says so deliberately, because an edit form needs the stored value rather
/// than a grouped one it would have to parse back. So this is the one place in
/// the app that formats money itself, through `Money.swift`, which is exactly
/// the door that exists for it.
struct TransactionLine: View {
    let row: TransactionRow
    var onRemove: ((TransactionRow) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.side == .buy ? "BUY" : "SELL")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Color(row.side == .buy ? Tokens.gain : Tokens.loss))
                    Text(row.tradeDate)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textSecondary))
                }
                Text(row.portfolioName)
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                Text(TransactionLine.quantityAtPrice(row))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
                if let fees = dec(row.fees), fees != 0 {
                    Text("fees \(fmtMoney(fees, currency: row.currency.rawValue))")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }

            if let onRemove {
                Button {
                    onRemove(row)
                } label: {
                    Image(systemName: "trash")
                        .foregroundStyle(Color(Tokens.textMuted))
                        // 44pt tap-target floor, same as every other icon
                        // control in the app.
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    "Delete \(row.side == .buy ? "buy" : "sell") of \(TransactionLine.quantityAtPrice(row)) on \(row.tradeDate)"
                )
            }
        }
        .padding(.vertical, 2)
    }

    /// "12 @ 231,10 USD". A quantity is not money and gets `fmtQuantity`, which
    /// drops trailing zeros — "12" rather than "12,00000000".
    ///
    /// `nonisolated` because a View is main-actor by default and this is pure
    /// string work: `TradeMark.from` calls it off the main actor.
    nonisolated static func quantityAtPrice(_ row: TransactionRow) -> String {
        let quantity = dec(row.quantity).map(fmtQuantity) ?? row.quantity
        let price = dec(row.price).map { fmtMoney($0, currency: row.currency.rawValue) } ?? row.price
        return "\(quantity) @ \(price)"
    }
}

extension TradeMark {
    /// The screen's own transaction rows, as marks for the price chart.
    ///
    /// The wording comes from `TransactionLine.quantityAtPrice` — the same
    /// call the row below the chart makes — so a marker's callout and that row
    /// can never word one trade two ways. `unitPriceRaw` is the row's RAW
    /// decimal string, which is what the placement compares on `Decimal`;
    /// nothing here parses a number.
    static func from(_ rows: [TransactionRow]) -> [TradeMark] {
        rows.map { row in
            TradeMark(
                id: row.id,
                label: row.symbol,
                side: row.side,
                tradeDate: row.tradeDate,
                unitPriceRaw: row.price,
                quantityText: TransactionLine.quantityAtPrice(row),
                priceText: nil,
                dateText: row.tradeDate
            )
        }
    }
}

// MARK: - Shared chrome

/// A titled card. Every panel on this screen is the same box, so they are one
/// definition rather than four near-copies that drift apart.
struct Panel<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(.caption, weight: .semibold))
                .foregroundStyle(Color(Tokens.textMuted))
                .textCase(.uppercase)

            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }
}

/// A label and its figure, with the figure right-aligned and tabular so a
/// column of them lines up.
struct FigureRow: View {
    let label: String
    let value: String
    var secondary: String?
    var direction: Direction?

    var body: some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textSecondary))
            Spacer(minLength: 8)
            Text(value)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(Color(direction?.token ?? Tokens.textPrimary))
            if let secondary {
                Text(secondary)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(Color(direction?.token ?? Tokens.textMuted))
            }
        }
    }
}

/// A stock page with only its header, and honest about it.
///
/// Everything below a header on this screen — the day's stats, the chart, the
/// position, the transactions behind it — is composed by the server out of
/// pieces this app deliberately does not hold (`src/lib/instruments/detail.ts`
/// is the one implementation, and a client-side second one would be a second
/// opinion about what a position is worth). So the seed draws the part it
/// genuinely knows and says plainly that the rest is waiting, rather than
/// rendering empty panels that would read as "you own nothing here".
private struct SeededHeader: View {
    let seed: InstrumentSeed
    let freshness: Freshness
    let retry: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                StaleBar(freshness: freshness)
                    .padding(.horizontal, -16)

                HStack(spacing: 12) {
                    TickerLogo(symbol: seed.symbol, size: 48, monogramChars: 4)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(seed.displayName)
                            .font(.system(.title3, weight: .semibold))
                            .foregroundStyle(Color(Tokens.textPrimary))

                        // No exchange: the holdings payload does not carry
                        // one, and inventing a plausible-looking venue is
                        // exactly the kind of small lie this whole type exists
                        // to avoid.
                        Text("\(seed.symbol) · \(seed.currency.rawValue)")
                            .font(.caption)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }

                    Spacer(minLength: 0)
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    // The same ladder the real header uses — live price, else
                    // the last saved one muted, else a dash.
                    Text(seed.price ?? seed.cachedPrice?.text ?? "—")
                        .font(.system(.title2, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(
                            Color(seed.price == nil && seed.cachedPrice != nil
                                ? Tokens.textMuted
                                : Tokens.textPrimary)
                        )

                    if seed.price != nil, let day = seed.dayPct {
                        Text(day.text)
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(Color(day.direction.token))
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Your position, the chart and this stock's transactions need a connection.")
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textMuted))

                    Button("Try now", action: retry)
                        .font(.subheadline)
                        .foregroundStyle(Color(Tokens.accent))
                }
                .padding(.top, 8)
            }
            .padding(16)
        }
        .refreshable { retry() }
    }
}
