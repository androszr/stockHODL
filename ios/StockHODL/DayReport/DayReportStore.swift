import Foundation
import Observation

@Observable
@MainActor
final class DayReportStore {
    private(set) var view: DayReportResponse?
    private(set) var selectedKind: DayReportKind = .close
    private(set) var selectedScopeID = allScopeID
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var stale = StaleState()
    var freshness: Freshness { stale.freshness }

    static let allScopeID = "all"
    static let genericError = "Could not load this day report."

    private let client: DayReportClient
    private let makeCache: @Sendable (String, TimeInterval) -> any PayloadCaching<DayReportResponse>
    private let tokenProvider: @MainActor () -> String?
    private let isConnected: @MainActor () -> Bool
    private var selectedDay: String?
    private var requestedNarratives = Set<String>()

    init(
        client: DayReportClient,
        makeCache: @escaping @Sendable (String, TimeInterval) -> any PayloadCaching<DayReportResponse> = {
            DiskCache<DayReportResponse>(key: $0, ttl: $1)
        },
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.client = client
        self.makeCache = makeCache
        self.tokenProvider = tokenProvider
        self.isConnected = isConnected
    }

    func load(day: String? = nil, kind: DayReportKind? = nil, portfolioId: String? = nil) async {
        if let kind { selectedKind = kind }
        selectedDay = day
        selectedScopeID = portfolioId ?? Self.allScopeID
        isLoading = true
        stale.connectivityChanged(to: isConnected())
        defer { isLoading = false }

        let identity = "day-report-\(portfolioId ?? "all")-\(day ?? "latest")-\(selectedKind.rawValue)"
        let ttl = view?.isLatest == true ? CacheTTL.intradaySeries : CacheTTL.dailySeries
        let cache = makeCache(identity, ttl)
        if let cached = cache.read() {
            apply(cached.value)
            stale.restored(from: cached.capturedAt)
        }
        guard let token = tokenProvider() else { return recordFailure() }
        do {
            let response = try await client.load(
                day: day,
                kind: selectedKind,
                portfolioId: portfolioId,
                token: token
            )
            apply(response)
            selectedDay = response.day
            let now = Date()
            stale.succeeded(at: now)
            cache.write(response, at: now)
            errorMessage = nil
            await requestNarrativeIfPending()
        } catch {
            #if DEBUG
                print("[day-report] load failed: \(error)")
            #endif
            recordFailure(error)
        }
    }

    func selectKind(_ kind: DayReportKind) async {
        guard kind != selectedKind else { return }
        await load(day: view?.day ?? selectedDay, kind: kind, portfolioId: portfolioId)
    }

    func stepPrev() async {
        guard let day = view?.prevDay else { return }
        await load(day: day, kind: selectedKind, portfolioId: portfolioId)
    }

    func stepNext() async {
        guard let day = view?.nextDay else { return }
        await load(day: day, kind: selectedKind, portfolioId: portfolioId)
    }

    func reload() async {
        await load(day: view?.day ?? selectedDay, kind: selectedKind, portfolioId: portfolioId)
    }

    func requestNarrativeIfPending() async {
        guard let view, view.narrative.status == .pending, let token = tokenProvider() else { return }
        let key = "\(view.day)-\(selectedKind.rawValue)-\(portfolioId ?? "all")"
        guard requestedNarratives.insert(key).inserted else { return }
        do {
            let response = try await client.generateNarrative(
                day: view.day,
                kind: selectedKind,
                portfolioId: portfolioId,
                token: token
            )
            if response.narrative.status != .ready, response.narrative.status != .refused {
                requestedNarratives.remove(key)
            }
            self.view = view.replacingNarrative(response.narrative)
        } catch {
            requestedNarratives.remove(key)
        }
    }

    func dismissError() { errorMessage = nil }
    func purge() {
        view = nil
        errorMessage = nil
        selectedDay = nil
        selectedKind = .close
        selectedScopeID = Self.allScopeID
        requestedNarratives.removeAll()
        stale.reset()
    }

    private var portfolioId: String? {
        selectedScopeID == Self.allScopeID ? nil : selectedScopeID
    }

    private func apply(_ response: DayReportResponse) {
        view = response
        selectedKind = DayReportKind(response.kind)
        selectedScopeID = response.scopeId ?? Self.allScopeID
    }

    private func recordFailure(_ error: Error? = nil) {
        stale.connectivityChanged(to: isConnected())
        stale.failed()
        if view == nil {
            errorMessage = LoadFailure.message(
                for: error,
                connected: stale.isConnected,
                generic: Self.genericError
            )
        }
    }
}

private extension DayReportResponse {
    func replacingNarrative(_ replacement: DayReportNarrative) -> DayReportResponse {
        DayReportResponse(
            benchmarks: benchmarks, day: day, dayLabel: dayLabel, events: events,
            figures: figures, headlines: headlines, isLatest: isLatest, kind: kind,
            movers: movers, narrative: replacement, nearestDay: nearestDay, nextDay: nextDay,
            optionMovers: optionMovers, prevDay: prevDay, recap: recap, scopeId: scopeId,
            scopes: scopes, segments: segments, status: status, usdPln: usdPln, valueLine: valueLine
        )
    }
}
