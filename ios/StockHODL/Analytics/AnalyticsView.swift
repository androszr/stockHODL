import SwiftUI

/// How the equity holdings have actually done, and where the money sits —
/// the phone's half of `/analytics`.
///
/// Reached as a push from Holdings, the same pattern Dividends uses, so the
/// four-slot tab bar stays a mirror of the web `NAV`. Nothing here fetches
/// except through `AnalyticsStore`, and nothing here folds money: every
/// figure on screen is a pre-formatted string from `getAnalyticsView`.
struct AnalyticsView: View {
    let store: AnalyticsStore

    /// The bulk-edit sheet lives HERE rather than inside `AllocationSection`,
    /// because it needs the store and the selected scope id — and only this
    /// view holds both.
    @State private var isEditingTargets = false

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .navigationTitle("Analytics")
        .navigationBarTitleDisplayMode(.inline)
        // `reload` rather than `load()`: a chip-selected scope must survive
        // SwiftUI re-running this task on a re-render. First open has no
        // last scope, so it still loads All.
        .task { await store.reload() }
        .alert(
            store.errorMessage ?? "",
            isPresented: .init(
                get: { store.errorMessage != nil && store.view != nil },
                set: { if !$0 { store.dismissError() } }
            )
        ) {
            Button("OK") { store.dismissError() }
        }
        .sheet(isPresented: $isEditingTargets) {
            // Presented only from the drift card's Edit button, which the
            // card hides on the All scope — so a scope id is always in hand.
            if let portfolioId = selectedPortfolioID {
                TargetEditSheet(
                    store: store,
                    portfolioId: portfolioId,
                    rows: store.view?.targetDrift?.rows ?? []
                )
            }
        }
    }

    /// The selected portfolio, or nil for All. `AnalyticsStore.allScopeID`
    /// is the sentinel, so a real id can never collide with it.
    private var selectedPortfolioID: String? {
        store.selectedScopeID == AnalyticsStore.allScopeID ? nil : store.selectedScopeID
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.view == nil {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.view == nil {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.reload() }
            }
        } else if let view = store.view {
            loaded(view)
        }
    }

    private func loaded(_ view: AnalyticsResponse) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                StaleBar(freshness: store.freshness)

                Text("How your equity holdings have actually done, and where the money sits.")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textMuted))

                ScopeChips(
                    chips: chips(for: view),
                    selected: store.selectedScopeID,
                    onSelect: { id in
                        Task {
                            await store.load(
                                portfolioId: id == AnalyticsStore.allScopeID ? nil : id
                            )
                        }
                    }
                )
                // ScopeChips pads itself to the screen edge, the Holdings
                // layout. The stack around it is already inset 16.
                .padding(.horizontal, -16)

                MetricTiles(view: view)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Against the market")
                        .font(.system(.headline, weight: .semibold))
                        .foregroundStyle(Color(Tokens.textPrimary))
                    ComparisonChart(
                        portfolio: view.benchmark.portfolio,
                        benchmark: view.benchmark.benchmark,
                        degradedReason: view.benchmark.degradedReason
                    )
                }

                AllocationSection(
                    breakdown: view.breakdown,
                    excludedSymbols: view.excludedSymbols,
                    concentration: view.concentration,
                    targetDrift: view.targetDrift,
                    isAllScope: selectedPortfolioID == nil,
                    onEditTargets: { isEditingTargets = true }
                )
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .refreshable { await store.reload() }
    }

    private func chips(for view: AnalyticsResponse) -> [ScopeChip] {
        var chips = [ScopeChip(id: AnalyticsStore.allScopeID, name: "All", txCount: nil)]
        for scope in view.scopes {
            chips.append(ScopeChip(id: scope.id, name: scope.name, txCount: nil))
        }
        return chips
    }
}

/// The two headline return figures, plus what they are measured from and
/// what they leave out. Every figure is a pre-formatted string; direction
/// comes from the server's `Direction`. A refusal renders an em dash with
/// its reason in words.
private struct MetricTiles: View {
    let view: AnalyticsResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                spacing: 12
            ) {
                tile(
                    label: "Money-weighted return (XIRR, p.a.)",
                    metric: view.xirr
                )
                tile(
                    label: "Time-weighted return (p.a.)",
                    metric: view.twrrAnnualized
                )
                tile(
                    label: "Time-weighted return (since inception)",
                    metric: view.twrrCumulative
                )
                gainTile
            }

            captions
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Returns")
    }

    private func tile(label: String, metric: AnalyticsMetric) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
                .fixedSize(horizontal: false, vertical: true)
            Text(metric.value)
                .font(.system(.title3, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Color(metric.direction.token))
            if let note = metric.note {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }

    private var gainTile: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Unrealized gain")
                .font(.caption)
                .foregroundStyle(Color(Tokens.textMuted))
            Text(view.totalGain ?? "—")
                .font(.system(.title3, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(
                    Color((view.totalGain == nil ? Direction.neutral : view.totalGainDirection).token)
                )
            Text(view.totalGain == nil ? "Nothing priced in this scope." : "Priced value \(view.totalValue ?? "—")")
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var captions: some View {
        let unpriced = view.excludedSymbols.filter { $0.reason == .noLiveQuote }.map(\.symbol)
        let unhistoried = view.excludedSymbols.filter { $0.reason == .noPriceHistory }.map(\.symbol)

        VStack(alignment: .leading, spacing: 6) {
            Text(inceptionLine)
                + Text(" Both figures cover equity TRADES only — dividends and option positions are not included. Time-weighted returns treat money in and out as arriving at the start of the day.")

            Text("Switching portfolio changes which trades are measured. The rates for each portfolio do not average to the All figures — only the amounts in the breakdown below add up.")

            if !unpriced.isEmpty {
                Text("Left out of every figure on this screen, because they could not be priced: \(unpriced.joined(separator: ", ")).")
            }
            if !unhistoried.isEmpty {
                Text("Left out of the two return figures only, because there is no price history to measure them against: \(unhistoried.joined(separator: ", ")). Their value today is still counted in the priced value and in the breakdown below.")
            }
            if view.skippedDays > 0 {
                Text(skippedLine)
            }
            if view.partialDays > 0 {
                Text(partialLine)
            }
        }
        .font(.caption2)
        .foregroundStyle(Color(Tokens.textMuted))
    }

    private var inceptionLine: String {
        if let iso = view.inceptionDateISO {
            "Measured since your first trade on \(iso)."
        } else {
            "No trades recorded in this scope yet."
        }
    }

    private var skippedLine: String {
        view.skippedDays == 1
            ? "On 1 day this portfolio held nothing, so that day is left out of the time-weighted return and the chain picks up again on the next day it held something."
            : "On \(view.skippedDays) days this portfolio held nothing, so those days are left out of the time-weighted return and the chain picks up again on the next day it held something."
    }

    private var partialLine: String {
        view.partialDays == 1
            ? "1 day was summed from an incomplete set of prices."
            : "\(view.partialDays) days were summed from an incomplete set of prices."
    }
}
