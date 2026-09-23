import Foundation
import Testing

@testable import StockHODL

private final class FakeDayReportServer: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var getCalls = 0
    private(set) var postCalls = 0
    private(set) var queries: [String] = []
    var response = DayReportFixture.payload()
    var narrativeResponse = DayReportFixture.narrativeResponse

    func transport() -> APIClient.Transport {
        { [self] request in
            let body: Data = lock.withLock {
                if request.httpMethod == "POST" {
                    postCalls += 1
                    return narrativeResponse
                }
                getCalls += 1
                queries.append(request.url?.query ?? "")
                return response
            }
            let http = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
            )!
            return (body, http)
        }
    }
}

enum DayReportFixture {
    static func payload(
        day: String = "2026-09-19",
        kind: String = "close",
        nextDay: String? = nil,
        narrativeStatus: String = "ready",
        scopeID: String? = nil,
        events: String = "[]"
    ) -> Data {
        let next = nextDay.map { "\"\($0)\"" } ?? "null"
        let scope = scopeID.map { "\"\($0)\"" } ?? "null"
        return Data(
            """
            {
              "status":"ready","nearestDay":null,"day":"\(day)","dayLabel":"Saturday, 19 September 2026",
              "kind":"\(kind)","prevDay":"2026-09-18","nextDay":\(next),"isLatest":true,
              "segments":{"morning":"ready","close":"ready"},"scopeId":\(scope),"scopes":[],
              "figures":{"status":"ready","source":"stored","valueAtClose":"10 000,00 zł",
                "dayChange":{"text":"+100,00 zł","direction":"gain"},"dayChangePct":"+1,00%",
                "holdings":null,"options":null,"optionsDayChangeUSD":null,"optionsNote":null,
                "optionsRelation":null,"partial":false,"partialSymbols":[],"excludedSymbols":[],"positionCount":1},
              "recap":null,"movers":[],"optionMovers":[],
              "valueLine":{"kind":"none","points":[],"windowLabel":null,"partialDays":0,"excludedSymbols":[]},
              "benchmarks":[],"usdPln":null,"headlines":[],
              "events":{"items":[],"earningsCaption":"Earnings dates appear in the written report."},
              "narrative":{"status":"\(narrativeStatus)","portfolioNarrative":null,"eventsNarrative":null,
                "macroNarrative":null,"events":\(events),"todayLine":null,"sources":[],"staleFigures":false}
            }
            """.utf8
        )
    }

    static let narrativeResponse = narrativePayload(status: "ready")

    static func narrativePayload(status: String) -> Data {
        let text = status == "ready" ? "\"Portfolio text\"" : "null"
        return Data(
        """
        {"narrative":{"status":"\(status)","portfolioNarrative":\(text),"eventsNarrative":null,
        "macroNarrative":null,"events":[],"todayLine":null,"sources":[],"staleFigures":false}}
        """.utf8
        )
    }

    static func decoded(_ data: Data) -> DayReportResponse {
        do {
            return try JSONDecoder().decode(DayReportResponse.self, from: data)
        } catch {
            fatalError("fixture does not decode: \(error)")
        }
    }
}

@MainActor
private func makeDayReportStore(
    _ server: FakeDayReportServer,
    cache: FakePayloadCache<DayReportResponse>? = nil
) -> DayReportStore {
    let caches = FakePayloadCacheFamily<DayReportResponse>()
    return DayReportStore(
        client: DayReportClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        makeCache: { key, _ in cache ?? caches.cache(for: key) },
        tokenProvider: { "signed.token" }
    )
}

@Suite("Day report store")
@MainActor
struct DayReportStoreTests {
    @Test("a cached report is replaced by the fresh network report")
    func cacheThenNetwork() async {
        let server = FakeDayReportServer()
        server.response = DayReportFixture.payload(day: "2026-09-22")
        let cache = FakePayloadCache(seed: DayReportFixture.decoded(DayReportFixture.payload(day: "2026-09-18")))
        let store = makeDayReportStore(server, cache: cache)

        await store.load(day: "2026-09-22", kind: .close)

        #expect(store.view?.day == "2026-09-22")
        #expect(cache.writes == 1)
    }

    @Test("next is a no-op at the latest day and keeps the selected half")
    func nextNoOp() async {
        let server = FakeDayReportServer()
        server.response = DayReportFixture.payload(kind: "morning")
        let store = makeDayReportStore(server)
        await store.load(kind: .morning)

        await store.stepNext()

        #expect(server.getCalls == 1)
        #expect(store.selectedKind == .morning)
    }

    @Test("a pending narrative is requested once")
    func narrativeOnce() async {
        let server = FakeDayReportServer()
        server.response = DayReportFixture.payload(narrativeStatus: "pending")
        let store = makeDayReportStore(server)

        await store.load()
        await store.requestNarrativeIfPending()

        #expect(server.postCalls == 1)
        #expect(store.view?.narrative.status == .ready)
    }

    @Test("a non-persisted narrative failure may retry after refresh")
    func narrativeFailureRetries() async {
        let server = FakeDayReportServer()
        server.response = DayReportFixture.payload(narrativeStatus: "pending")
        server.narrativeResponse = DayReportFixture.narrativePayload(status: "unavailable")
        let store = makeDayReportStore(server)

        await store.load()
        #expect(store.view?.narrative.status == .unavailable)

        server.narrativeResponse = DayReportFixture.narrativeResponse
        await store.reload()

        #expect(server.postCalls == 2)
        #expect(store.view?.narrative.status == .ready)
    }

    @Test("there is one report for everything held: no scope ever reaches the query")
    func noScopeQuery() async {
        let server = FakeDayReportServer()
        let store = makeDayReportStore(server)
        await store.load()
        await store.selectKind(.morning)
        await store.reload()

        #expect(server.queries.allSatisfy { !$0.contains("p=") })
    }

    @Test("switching half reloads the same day")
    func kindKeepsDay() async {
        let server = FakeDayReportServer()
        let store = makeDayReportStore(server)
        await store.load(day: "2026-09-19", kind: .close)

        server.response = DayReportFixture.payload(kind: "morning")
        await store.selectKind(.morning)

        #expect(server.queries.last?.contains("day=2026-09-19") == true)
        #expect(server.queries.last?.contains("kind=morning") == true)
    }
}
