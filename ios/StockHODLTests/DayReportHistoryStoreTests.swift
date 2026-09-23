import Foundation
import Testing

@testable import StockHODL

private final class FakeDayReportHistoryServer: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls = 0
    private(set) var queries: [String] = []
    /// Answers by cursor: `firstPage` for page one, the cursor string for later pages.
    static let firstPage = ""
    var pages: [String: Data] = [firstPage: DayReportHistoryFixture.page(days: ["2026-09-18", "2026-09-17"], nextCursor: nil)]
    var fails = false

    func transport() -> APIClient.Transport {
        { [self] request in
            let (body, status): (Data, Int) = lock.withLock {
                calls += 1
                let query = request.url?.query ?? ""
                queries.append(query)
                if fails { return (Data("{\"error\":\"down\"}".utf8), 503) }
                let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "cursor" }?.value ?? Self.firstPage
                return (pages[cursor] ?? Data("{\"items\":[],\"nextCursor\":null}".utf8), 200)
            }
            let http = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
            )!
            return (body, http)
        }
    }
}

enum DayReportHistoryFixture {
    static func item(day: String, kind: String = "close", change: String? = "+100,00 zł", partial: Bool = false) -> String {
        let figureDay = kind == "morning" ? "\"2026-09-16\"" : "\"\(day)\""
        let figureLabel = kind == "morning" ? "\"Wed 16 Sep\"" : "\"Thu 17 Sep\""
        let changeJSON = change.map { "{\"text\":\"\($0)\",\"direction\":\"gain\"}" } ?? "null"
        let pct = change == nil ? "null" : "\"+1,00%\""
        return """
        {"day":"\(day)","kind":"\(kind)","dayLabel":"Thu 17 Sep","figureDay":\(figureDay),
         "figureDayLabel":\(figureLabel),"dayChange":\(changeJSON),"dayChangePct":\(pct),
         "partial":\(partial),"narrativeStatus":"ready"}
        """
    }

    static func page(days: [String], nextCursor: String?) -> Data {
        let items = days.map { item(day: $0) }.joined(separator: ",")
        let cursor = nextCursor.map { "\"\($0)\"" } ?? "null"
        return Data("{\"items\":[\(items)],\"nextCursor\":\(cursor)}".utf8)
    }

    static func decoded(_ data: Data) -> DayReportHistoryResponse {
        try! JSONDecoder().decode(DayReportHistoryResponse.self, from: data)
    }

    static func decodedItem(_ json: String) -> DayReportHistoryItem {
        try! JSONDecoder().decode(DayReportHistoryItem.self, from: Data(json.utf8))
    }
}

@MainActor
private func makeStore(
    _ server: FakeDayReportHistoryServer,
    cache: FakePayloadCache<DayReportHistoryResponse>
) -> DayReportHistoryStore {
    DayReportHistoryStore(
        client: DayReportClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        makeCache: { _, _ in cache },
        tokenProvider: { "signed.token" }
    )
}

@Suite("Day report history store")
@MainActor
struct DayReportHistoryStoreTests {
    @Test("a cached page paints first and the network page replaces it")
    func cacheThenNetwork() async {
        let server = FakeDayReportHistoryServer()
        server.pages[FakeDayReportHistoryServer.firstPage] = DayReportHistoryFixture.page(days: ["2026-09-18"], nextCursor: nil)
        let cache = FakePayloadCache(
            seed: DayReportHistoryFixture.decoded(DayReportHistoryFixture.page(days: ["2026-09-11"], nextCursor: nil))
        )
        let store = makeStore(server, cache: cache)

        await store.load()

        #expect(store.items.map(\.day) == ["2026-09-18"])
        #expect(cache.writes == 1)
        #expect(store.errorMessage == nil)
        #expect(store.stale.isConfirmed)
    }

    @Test("show more sends the cursor and appends without duplicating a row")
    func loadMoreAppends() async {
        let server = FakeDayReportHistoryServer()
        server.pages[FakeDayReportHistoryServer.firstPage] = DayReportHistoryFixture.page(days: ["2026-09-18", "2026-09-17"], nextCursor: "2026-09-17:close")
        // The older page repeats the cursor row — a report written between two presses.
        server.pages["2026-09-17:close"] = DayReportHistoryFixture.page(days: ["2026-09-17", "2026-09-16"], nextCursor: nil)
        let store = makeStore(server, cache: FakePayloadCache())

        await store.load()
        await store.loadMore()

        #expect(server.queries.last?.contains("cursor=2026-09-17") == true)
        #expect(store.items.map(\.day) == ["2026-09-18", "2026-09-17", "2026-09-16"])
        #expect(store.nextCursor == nil)
    }

    @Test("show more makes no request without a cursor")
    func loadMoreWithoutCursor() async {
        let server = FakeDayReportHistoryServer()
        let store = makeStore(server, cache: FakePayloadCache())

        await store.load()
        let after = server.calls
        await store.loadMore()

        #expect(server.calls == after)
        #expect(store.items.count == 2)
    }

    @Test("a failure with a cached page keeps the list and raises no error")
    func failureWithCache() async {
        let server = FakeDayReportHistoryServer()
        server.fails = true
        let cache = FakePayloadCache(
            seed: DayReportHistoryFixture.decoded(DayReportHistoryFixture.page(days: ["2026-09-11"], nextCursor: nil)),
            capturedAt: Date(timeIntervalSinceNow: -3600)
        )
        let store = makeStore(server, cache: cache)

        await store.load()

        #expect(store.items.map(\.day) == ["2026-09-11"])
        #expect(store.errorMessage == nil)
        #expect(!store.stale.isConfirmed)
    }

    @Test("a failure with nothing cached surfaces the generic sentence")
    func failureWithoutCache() async {
        let server = FakeDayReportHistoryServer()
        server.fails = true
        let store = makeStore(server, cache: FakePayloadCache())

        await store.load()

        #expect(store.items.isEmpty)
        #expect(store.errorMessage == DayReportHistoryStore.genericError)
    }

    @Test("show more never writes the cache — only page one is kept on disk")
    func loadMoreDoesNotCache() async {
        let server = FakeDayReportHistoryServer()
        server.pages[FakeDayReportHistoryServer.firstPage] = DayReportHistoryFixture.page(days: ["2026-09-18"], nextCursor: "2026-09-18:close")
        server.pages["2026-09-18:close"] = DayReportHistoryFixture.page(days: ["2026-09-17"], nextCursor: nil)
        let cache = FakePayloadCache<DayReportHistoryResponse>()
        let store = makeStore(server, cache: cache)

        await store.load()
        #expect(cache.writes == 1)
        await store.loadMore()

        #expect(cache.writes == 1)
        #expect(store.items.count == 2)
    }
}
