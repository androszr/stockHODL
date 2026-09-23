import Foundation
import Observation

/// The portfolio series — what the whole book has been worth over a range.
///
/// Its own client rather than a method on `LiveClient`: the live payload is a
/// pump on a one-second budget and this is a comparatively expensive walk over
/// history. Keeping them apart is what stops a range switch from riding on the
/// quote cadence.
struct PortfolioSeriesClient: Sendable {
    let api: APIClient

    /// `portfolioId` is a FILTER, not authorization. A foreign, malformed or
    /// deleted id resolves server-side to the all-portfolios series rather
    /// than a 404 — never an error, and nothing enumerable. The web's rule.
    func series(
        range: ChartRange,
        portfolioId: String?,
        token: String
    ) async throws -> SeriesPayload {
        var query = ["range": range.rawValue]
        if let portfolioId { query["portfolioId"] = portfolioId }

        return try await api.decode(
            SeriesPayload.self,
            from: APIRequest(
                path: "/api/mobile/v1/series/portfolio",
                query: query,
                bearerToken: token
            )
        )
    }
}

/// The Holdings chart: range, mode, and the one series in flight.
///
/// Separate from `LiveStore` on purpose. `LiveStore` re-renders on every
/// streamed tick, and a chart that reloaded with it would refetch a five-year
/// walk once a second. This store changes only when the user changes a
/// control or the scope moves.
///
/// Mode is NOT one of those changes. Both curves ride in the same payload —
/// every point carries `v` and, on a portfolio series, `r` — so toggling
/// Value/Return is pure display and never touches the network. That guarantee
/// is why `mode` lives here as plain state with no `didSet` reload.
@MainActor
@Observable
final class PortfolioChartStore {
    private(set) var series: SeriesPayload?
    private(set) var state: ChartState = .loading

    /// Which range is charted. Shares `ChartRange`'s app-wide memory with the
    /// instrument chart — a user who thinks in months thinks in months
    /// everywhere.
    var range: ChartRange {
        didSet {
            guard oldValue != range else { return }
            range.remember(in: defaults)
            reload()
        }
    }

    /// Value or Return. Remembered, and display-only.
    var mode: ChartMode {
        didSet {
            guard oldValue != mode else { return }
            mode.remember(for: .portfolio, in: defaults)
        }
    }

    /// The selected scope, or nil for every portfolio. Set by the screen that
    /// owns the chips; a change reloads, because a different scope is a
    /// different series rather than a different view of one.
    private(set) var portfolioID: String?

    private let client: PortfolioSeriesClient
    private let tokenProvider: @MainActor () -> String?
    private let defaults: UserDefaults
    /// The one in-flight load. A user tapping 1D→5D→1M faster than the network
    /// answers must not get whichever response lands last painted under
    /// whichever tab happens to be selected.
    private var task: Task<Void, Never>?

    init(
        client: PortfolioSeriesClient,
        tokenProvider: @escaping @MainActor () -> String?,
        defaults: UserDefaults = .standard
    ) {
        self.client = client
        self.tokenProvider = tokenProvider
        self.defaults = defaults
        range = ChartRange.remembered(in: defaults)
        mode = ChartMode.remembered(for: .portfolio, in: defaults)
    }

    /// Called by the screen when the chip selection changes. Takes the chip id,
    /// which is `LiveStore.allScopeID` for "All" — translated here so no other
    /// file has to know that the sentinel is not a portfolio id.
    func scopeChanged(to scopeID: String?) {
        let next = (scopeID == nil || scopeID == LiveStore.allScopeID) ? nil : scopeID
        guard next != portfolioID else { return }
        portfolioID = next
        reload()
    }

    /// First load. Idempotent: a screen that reappears gets what it already
    /// had rather than a spinner over a correct chart.
    func loadIfNeeded() {
        guard series == nil, task == nil else { return }
        reload()
    }

    func reload() {
        task?.cancel()
        state = .loading
        task = Task { [weak self] in
            guard let self, let token = tokenProvider() else { return }
            let fresh = try? await client.series(
                range: range,
                portfolioId: portfolioID,
                token: token
            )
            guard !Task.isCancelled else { return }
            apply(fresh)
            task = nil
        }
    }

    /// An empty payload and a failed request are different things and get
    /// different states: "no data for this range" is an answer, "couldn't
    /// load" is a question the user can retry.
    private func apply(_ fresh: SeriesPayload?) {
        guard let fresh else {
            state = .error
            return
        }
        series = fresh
        state = fresh.points.count >= 2 ? .ready : .empty
    }

    var points: [ChartPoint] { series?.points ?? [] }

    /// What an empty frame should say, which depends on the mode.
    ///
    /// Return mode comes up short two ways — nothing owned in the window (no
    /// basis at all) and exactly one owned point (a real return, but a curve
    /// needs two) — and both deserve the same sentence. Claiming "no cost" on
    /// the day of the first buy would simply be false.
    var emptyMessage: String {
        switch mode {
        case .value: "No history for this range yet."
        case .percentReturn: "Not enough owned days in this range to draw a return."
        }
    }

    func purge() {
        task?.cancel()
        task = nil
        series = nil
        state = .loading
        portfolioID = nil
    }
}
