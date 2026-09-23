import Foundation
import Observation

/// The chart behind one market tile — S&P 500, Nasdaq, Dow or USD/PLN.
///
/// `InstrumentStore` trimmed to the one thing this screen fetches: the
/// series. There is no detail call (the header comes from the Dashboard's
/// `MarketStripStore`, which the screen reads directly), no watch, no
/// targets and no transactions — an index or a currency is not something
/// you hold, and a store with nothing to write cannot write the wrong thing.
///
/// Cached on disk per key AND per range, the instrument screen's discipline:
/// `1D` and `1Y` are different questions with different shelf lives, and one
/// file would let a tap through the range tabs overwrite the answer to
/// whichever was asked last. For the currency this cache IS the cache — the
/// server stores no forex history and fetches it per request.
@MainActor
@Observable
final class MarketDetailStore {
    let key: MarketTileKey

    private(set) var series: SeriesPayload?
    private(set) var seriesState: ChartState = .loading

    /// Which range is charted. Remembered app-wide, the same `chart.range`
    /// key every other chart reads, so a user who thinks in months thinks in
    /// months here too. A tolerant read: an unknown stored value falls back.
    var range: ChartRange {
        didSet {
            guard oldValue != range else { return }
            range.remember(in: defaults)
            reloadSeries()
        }
    }

    /// Line or candles, remembered like the range.
    var style: ChartStyle {
        didSet {
            guard oldValue != style else { return }
            style.remember(in: defaults)
        }
    }

    /// Freshness of the CHART. The header's freshness is the strip's.
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    private let client: MarketStripClient
    private let makeSeriesCache: @Sendable (String) -> any PayloadCaching<SeriesPayload>
    private let tokenProvider: @MainActor () -> String?
    private let isConnected: @MainActor () -> Bool
    private let defaults: UserDefaults
    /// The one in-flight series task — see `InstrumentStore.seriesTask`.
    private var seriesTask: Task<Void, Never>?

    init(
        key: MarketTileKey,
        client: MarketStripClient,
        makeSeriesCache: (@Sendable (String) -> any PayloadCaching<SeriesPayload>)? = nil,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true },
        range: ChartRange? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.key = key
        self.client = client
        self.makeSeriesCache = makeSeriesCache ?? { cacheKey in
            // The instrument store's split: intraday goes stale in an hour;
            // a daily walk carries today's forming last and gets the same
            // hour rather than a day of yesterday-without-today.
            let intraday = cacheKey.hasSuffix("1D") || cacheKey.hasSuffix("5D")
            return DiskCache<SeriesPayload>(
                key: "market-\(cacheKey)",
                ttl: intraday ? CacheTTL.intradaySeries : CacheTTL.formingDailySeries
            )
        }
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
        self.defaults = defaults
        self.range = range ?? .remembered(in: defaults)
        style = ChartStyle.remembered(in: defaults)
    }

    // MARK: - Loading

    func load() async {
        stale.connectivityChanged(to: isConnected())

        // Disk first: a tile tapped on a train gets its chart, not an apology.
        if series == nil, let cached = seriesCache(for: range).read() {
            apply(series: cached.value)
            stale.restored(from: cached.capturedAt)
        }

        // No token is a real failure, not a reason to hang: the chart starts
        // in `.loading`, and returning here would leave it on its spinner
        // with nothing on the way and no way back except popping.
        guard let token = tokenProvider() else {
            apply(series: nil)
            recordFailure()
            return
        }

        seriesTask?.cancel()
        let wanted = range
        do {
            let fresh = try await client.series(key: key, range: wanted, token: token)
            // A range switch mid-flight lands its own answer; this one is
            // for a window nobody is looking at any more.
            guard wanted == range else { return }
            apply(series: fresh)
            let now = Date()
            stale.succeeded(at: now)
            seriesCache(for: wanted).write(fresh, at: now)
        } catch {
            #if DEBUG
                print("[market-detail] \(key.rawValue) failed: \(error)")
            #endif
            guard wanted == range else { return }
            apply(series: nil)
            recordFailure()
        }
    }

    private func recordFailure() {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
    }

    /// Keyed by tile AND range — both are part of the question.
    private func seriesCache(for range: ChartRange) -> any PayloadCaching<SeriesPayload> {
        makeSeriesCache("\(key.rawValue)-\(range.rawValue)")
    }

    private func reloadSeries() {
        seriesTask?.cancel()
        let wanted = range
        // Paint the cached window for the new range at once rather than
        // dropping to a spinner — three spinners that each resolve to an
        // error is what tapping through 1D→5D→1M offline used to give.
        if let cached = seriesCache(for: wanted).read() {
            apply(series: cached.value)
        } else {
            seriesState = .loading
        }
        seriesTask = Task { [weak self] in
            guard let self else { return }
            guard let token = tokenProvider() else {
                // No session is a failure like any other: leave the
                // spinner and the tap looks hung until the next one.
                apply(series: nil)
                recordFailure()
                return
            }
            let fresh = try? await client.series(key: key, range: wanted, token: token)
            guard !Task.isCancelled else { return }
            // The range may have moved on while this was in flight; writing
            // then would file one range's points under another's key.
            guard wanted == range else { return }
            apply(series: fresh)
            if let fresh {
                let now = Date()
                stale.succeeded(at: now)
                seriesCache(for: wanted).write(fresh, at: now)
            } else {
                recordFailure()
            }
        }
    }

    /// An empty payload and a failed request are different things and get
    /// different states: "no data for this range" is an answer, "couldn't
    /// load" is a question the user can retry.
    private func apply(series fresh: SeriesPayload?) {
        guard let fresh else {
            // A failure over a chart that is already drawn leaves it drawn.
            if series == nil { seriesState = .error }
            return
        }
        series = fresh
        seriesState = fresh.points.count >= 2 ? .ready : .empty
    }

    // MARK: - Derived

    var points: [ChartPoint] { series?.points ?? [] }

    /// How the chart prints its figures: a rate to four decimals for the
    /// currency, USD money for the three ETF-proxied indices.
    var unit: ChartUnit { key == .usdpln ? .rate : .money }

    /// The currency the money unit formats in. Irrelevant for `.rate`, which
    /// prints no suffix, but the chart takes one regardless.
    var currency: String { key == .usdpln ? "PLN" : "USD" }
}
