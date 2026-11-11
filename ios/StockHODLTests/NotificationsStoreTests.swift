import Foundation
import Testing

@testable import StockHODL

/// Records every request and answers the preferences endpoint from a
/// mutable in-memory row, the way the real route does.
private final class FakePreferencesServer: @unchecked Sendable {
    struct Call {
        let method: String
        let path: String
        let body: Data?
    }

    private let lock = NSLock()
    private var recorded: [Call] = []

    /// The raw JSON `GET` answers — a string so a test can omit a key.
    var getBody = #"{"priceAlerts":true,"dailySummary":true,"dayReports":false}"#
    var putStatus = 200

    var calls: [Call] { lock.withLock { recorded } }

    func transport() -> APIClient.Transport {
        { [self] request in
            let method = request.httpMethod ?? "GET"
            let (status, payload): (Int, Data) = lock.withLock {
                recorded.append(Call(method: method, path: request.url?.path ?? "", body: request.httpBody))
                if method == "GET" { return (200, Data(getBody.utf8)) }
                return putStatus >= 400
                    ? (putStatus, Data(#"{"error":"nope"}"#.utf8))
                    : (200, Data(#"{"ok":true}"#.utf8))
            }
            let http = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!
            return (payload, http)
        }
    }
}

@MainActor
private func makeStore(server: FakePreferencesServer, token: String? = "signed.token") -> NotificationsStore {
    let config = AppConfig(baseURL: URL(string: "https://example.test")!)
    // A private suite per store: the display cache must not leak between
    // tests, or into the simulator's real defaults.
    let defaults = UserDefaults(suiteName: "notifications-store-tests-\(UUID().uuidString)")!
    return NotificationsStore(
        client: PushTokenClient(api: APIClient(config: config, transport: server.transport())),
        tokenProvider: { token },
        environment: .sandbox,
        defaults: defaults
    )
}

private func decodedBody(_ call: FakePreferencesServer.Call) throws -> [String: Bool] {
    try JSONDecoder().decode([String: Bool].self, from: try #require(call.body))
}

@Suite("Notifications store — the Daily reports pause")
@MainActor
struct NotificationsStoreDayReportsTests {
    @Test("starts paused, and stays paused when the server says so")
    func loadsPaused() async {
        let server = FakePreferencesServer()
        let store = makeStore(server: server)
        #expect(store.dayReportsEnabled == false)

        await store.load()

        #expect(store.hasLoaded)
        #expect(store.dayReportsEnabled == false)
        #expect(store.dailySummaryEnabled == true)
    }

    @Test("reads the switch on from the server")
    func loadsOn() async {
        let server = FakePreferencesServer()
        server.getBody = #"{"priceAlerts":false,"dailySummary":false,"dayReports":true}"#
        let store = makeStore(server: server)

        await store.load()

        #expect(store.dayReportsEnabled == true)
    }

    @Test("a server older than the switch paints it off instead of failing to load")
    func toleratesAMissingKey() async {
        let server = FakePreferencesServer()
        server.getBody = #"{"priceAlerts":true,"dailySummary":false}"#
        let store = makeStore(server: server)

        await store.load()

        #expect(store.hasLoaded)
        #expect(store.dayReportsEnabled == false)
        #expect(store.priceAlertsEnabled == true)
    }

    @Test("turning it on saves all three switches and leaves the push switches alone")
    func turnsOn() async throws {
        let server = FakePreferencesServer()
        let store = makeStore(server: server)
        await store.load()

        await store.setDayReports(true)

        #expect(store.dayReportsEnabled == true)
        #expect(store.errorMessage == nil)
        let put = try #require(server.calls.last)
        #expect(put.method == "PUT")
        #expect(put.path == "/api/mobile/v1/notification-preferences")
        #expect(try decodedBody(put) == ["priceAlerts": true, "dailySummary": true, "dayReports": true])
    }

    @Test("pausing never touches the device registration — it is not a notification")
    func pausingLeavesTheTokenAlone() async throws {
        let server = FakePreferencesServer()
        server.getBody = #"{"priceAlerts":false,"dailySummary":false,"dayReports":true}"#
        let store = makeStore(server: server)
        await store.load()

        await store.setDayReports(false)

        #expect(store.dayReportsEnabled == false)
        #expect(!server.calls.contains { $0.path == "/api/mobile/v1/push-token" })
        #expect(try decodedBody(try #require(server.calls.last))["dayReports"] == false)
    }

    @Test("a failed save keeps the old value and says so")
    func failedSaveReverts() async {
        let server = FakePreferencesServer()
        let store = makeStore(server: server)
        await store.load()
        server.putStatus = 500

        await store.setDayReports(true)

        #expect(store.dayReportsEnabled == false)
        #expect(store.errorMessage == "Could not save the daily reports setting.")
        #expect(store.isBusy == false)
    }

    @Test("signed out, the switch sends nothing")
    func withoutAToken() async {
        let server = FakePreferencesServer()
        let store = makeStore(server: server, token: nil)

        await store.setDayReports(true)

        #expect(server.calls.isEmpty)
        #expect(store.dayReportsEnabled == false)
    }
}

@Suite("Settings — the Daily reports row")
@MainActor
struct SettingsDayReportsRowTests {
    @Test("locked until the server has answered, then free")
    func lockFollowsTheServer() async {
        let server = FakePreferencesServer()
        let store = makeStore(server: server)
        #expect(SettingsView.dayReportsLocked(store))

        await store.load()

        #expect(!SettingsView.dayReportsLocked(store))
    }

    @Test("the footer says paused in words when it is off")
    func footerNamesTheState() {
        #expect(SettingsView.dayReportsFooter(enabled: false).hasPrefix("Paused"))
        #expect(!SettingsView.dayReportsFooter(enabled: true).contains("Paused"))
    }
}
