import Foundation
import Testing

@testable import StockHODL

// MARK: - Doubles

private final class FakeTokens: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    init(_ value: String?) { self.value = value }
    func read() throws -> String? { lock.withLock { value } }
    func write(_ token: String) throws { lock.withLock { value = token } }
    func clear() throws { lock.withLock { value = nil } }
}

private final class FakeCache: WidgetCaching, @unchecked Sendable {
    private let lock = NSLock()
    private var value: CachedWidgetPayload?
    private(set) var writes = 0
    init(_ value: CachedWidgetPayload? = nil) { self.value = value }
    func read() -> CachedWidgetPayload? { lock.withLock { value } }
    func write(_ cached: CachedWidgetPayload) {
        lock.withLock {
            value = cached
            writes += 1
        }
    }
    var stored: CachedWidgetPayload? { lock.withLock { value } }
}

// MARK: - Fixtures

private let config = AppConfig(baseURL: URL(string: "https://sawa-finance.vercel.app")!)
private let now = Date(timeIntervalSince1970: 1_754_800_000)

/// A minimal but REAL server payload, spelled as JSON rather than built as a
/// struct: the thing worth pinning is that what `/api/mobile/v1/widget`
/// actually sends decodes into the generated contract.
private let payloadJSON = """
{
  "holdings": {
    "totalValue": "148 250,00 zł",
    "dayChange": { "text": "+1 240,00 zł (+0,84%)", "direction": "gain" },
    "totalChange": { "text": "+18 400,00 zł (+14,20%)", "direction": "gain" },
    "dayChangePct": "+0,84%",
    "totalChangePct": "+14,20%",
    "excludedSymbols": [],
    "partialDayChange": false
  },
  "options": {
    "totalValue": "$3 772.00",
    "dayChange": { "text": "-$42.00 (-1,10%)", "direction": "loss" },
    "totalChange": { "text": "+$610.00 (+19,30%)", "direction": "gain" },
    "dayChangePct": "-1,10%",
    "totalChangePct": "+19,30%",
    "excludedSymbols": [],
    "partialDayChange": false
  },
  "market": {
    "status": "open",
    "nextTransitionAtMs": null,
    "nextTransitionKind": null,
    "pollingResumesAtMs": null,
    "serverNowMs": 1754800000000
  }
}
"""

private func client(
    status: Int = 200,
    body: String = payloadJSON,
    onRequest: (@Sendable (URLRequest) -> Void)? = nil
) -> APIClient {
    APIClient(config: config) { request in
        onRequest?(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        return (Data(body.utf8), response)
    }
}

private func failingClient() -> APIClient {
    APIClient(config: config) { _ in throw URLError(.notConnectedToInternet) }
}

private func cached(_ value: String, at date: Date) -> CachedWidgetPayload {
    var json = payloadJSON
    json = json.replacingOccurrences(of: "148 250,00 zł", with: value)
    let payload = try! JSONDecoder().decode(WidgetSummaryResponse.self, from: Data(json.utf8))
    return CachedWidgetPayload(payload: payload, capturedAt: date)
}

// MARK: - Tests

/// What a widget draws, and why — the decision the user actually sees.
///
/// The failure modes here are the ones that make a widget feel broken rather
/// than merely late: a placeholder because one request hit a tunnel, a stale
/// balance beside a session that has already been revoked, and a signed-out
/// widget burning its refresh budget re-discovering that it is signed out.
@Suite("WidgetDataSource")
struct WidgetDataSourceTests {
    @Test("a fresh payload is returned and cached")
    func freshPayload() async {
        let cache = FakeCache()
        let source = WidgetDataSource(api: client(), tokens: FakeTokens("t"), cache: cache)

        let outcome = await source.load(now: now)

        guard case let .figures(payload, capturedAt) = outcome else {
            Issue.record("expected figures, got \(outcome)")
            return
        }
        #expect(payload.holdings.totalValue == "148 250,00 zł")
        #expect(payload.options.totalValue == "$3 772.00")
        // The percent-only fields are the whole reason the contract grew: a
        // lock screen has no room for the amount beside them.
        #expect(payload.holdings.dayChangePct == "+0,84%")
        #expect(payload.dayLines == nil)
        // Nil means live — the view shows no age caption.
        #expect(capturedAt == nil)
        #expect(cache.stored?.capturedAt == now)
    }

    @Test("a payload with dayLines decodes and the figures stay intact")
    func dayLinesAreOptionalAndDoNotTouchFigures() async {
        let json = """
        {
          "holdings": {
            "totalValue": "148 250,00 zł",
            "dayChange": { "text": "+1 240,00 zł (+0,84%)", "direction": "gain" },
            "totalChange": { "text": "+18 400,00 zł (+14,20%)", "direction": "gain" },
            "dayChangePct": "+0,84%",
            "totalChangePct": "+14,20%",
            "excludedSymbols": [],
            "partialDayChange": false
          },
          "options": {
            "totalValue": "$3 772.00",
            "dayChange": { "text": "-$42.00 (-1,10%)", "direction": "loss" },
            "totalChange": { "text": "+$610.00 (+19.30%)", "direction": "gain" },
            "dayChangePct": "-1,10%",
            "totalChangePct": "+19,30%",
            "excludedSymbols": [],
            "partialDayChange": false
          },
          "market": {
            "status": "open",
            "nextTransitionAtMs": null,
            "nextTransitionKind": null,
            "pollingResumesAtMs": null,
            "serverNowMs": 1754800000000
          },
          "dayLines": {
            "sessionOpenMs": 0,
            "sessionCloseMs": 100,
            "holdings": [{"t": 0, "p": "-1.43"}],
            "options": [{"t": 0, "p": "-8.92"}]
          }
        }
        """
        let payload = try! JSONDecoder().decode(WidgetSummaryResponse.self, from: Data(json.utf8))
        #expect(payload.holdings.totalValue == "148 250,00 zł")
        #expect(payload.options.totalValue == "$3 772.00")
        #expect(payload.dayLines?.holdings.first?.p == "-1.43")
        #expect(payload.dayLines?.options.first?.p == "-8.92")
    }

    @Test("it asks the thin widget route, with the bearer token")
    func callsTheWidgetRoute() async {
        let seen = Recorder()
        let source = WidgetDataSource(
            api: client(onRequest: { seen.record($0) }),
            tokens: FakeTokens("token-123"),
            cache: FakeCache()
        )

        _ = await source.load(now: now)

        // Never /live or /options: those answer every holding, every cached
        // price and a full greeks load to render two numbers.
        #expect(seen.path == "/api/mobile/v1/widget")
        #expect(seen.authorization == "Bearer token-123")
    }

    @Test("no token means signed out, without a request")
    func signedOutMakesNoRequest() async {
        let seen = Recorder()
        let source = WidgetDataSource(
            api: client(onRequest: { seen.record($0) }),
            tokens: FakeTokens(nil),
            cache: FakeCache()
        )

        #expect(await source.load(now: now) == .signedOut)
        // A widget that cannot be signed in must not spend a reload finding
        // that out again every fifteen minutes.
        #expect(seen.path == nil)
    }

    @Test("a dropped connection falls back to the cache, dated")
    func offlineUsesCache() async {
        let capturedAt = now.addingTimeInterval(-3600)
        let source = WidgetDataSource(
            api: failingClient(),
            tokens: FakeTokens("t"),
            cache: FakeCache(cached("111 000,00 zł", at: capturedAt))
        )

        guard case let .figures(payload, age) = await source.load(now: now) else {
            Issue.record("expected the cached figures")
            return
        }
        #expect(payload.holdings.totalValue == "111 000,00 zł")
        // Non-nil age is what makes the view admit the number is old.
        #expect(age == capturedAt)
    }

    @Test("a server error falls back to the cache too")
    func serverErrorUsesCache() async {
        let source = WidgetDataSource(
            api: client(status: 503, body: "{}"),
            tokens: FakeTokens("t"),
            cache: FakeCache(cached("111 000,00 zł", at: now))
        )

        #expect(await source.load(now: now).payload?.holdings.totalValue == "111 000,00 zł")
    }

    @Test("a first run with no network and no cache is blank, not a lie")
    func coldFailureIsUnavailable() async {
        let source = WidgetDataSource(
            api: failingClient(),
            tokens: FakeTokens("t"),
            cache: FakeCache()
        )

        #expect(await source.load(now: now) == .unavailable)
    }

    @Test("a revoked session is signed out, never cached money")
    func unauthorizedIgnoresCache() async {
        let cache = FakeCache(cached("111 000,00 zł", at: now))
        let source = WidgetDataSource(
            api: client(status: 401, body: #"{"message":"Not signed in."}"#),
            tokens: FakeTokens("stale"),
            cache: cache
        )

        // Showing a balance beside a dead session is the one failure the user
        // cannot act on — it looks live and is not.
        #expect(await source.load(now: now) == .signedOut)
        // The cache survives for the moment they sign back in.
        #expect(cache.stored != nil)
    }

    @Test("a malformed payload falls back rather than crashing the timeline")
    func decodeFailureUsesCache() async {
        let source = WidgetDataSource(
            api: client(body: #"{"holdings":"nope"}"#),
            tokens: FakeTokens("t"),
            cache: FakeCache(cached("111 000,00 zł", at: now))
        )

        #expect(await source.load(now: now).payload?.holdings.totalValue == "111 000,00 zł")
    }
}

/// Captures the one request under test. A class because the transport closure
/// is `@Sendable` and the assertion happens after it has run.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var request: URLRequest?

    func record(_ request: URLRequest) { lock.withLock { self.request = request } }

    var path: String? { lock.withLock { request?.url?.path() } }
    var authorization: String? {
        lock.withLock { request?.value(forHTTPHeaderField: "Authorization") }
    }
}
