import Foundation
import Testing

@testable import StockHODL

/// A snapshot store held in memory.
///
/// `@unchecked Sendable` with a lock rather than an actor: `SnapshotStoring` is
/// deliberately synchronous — the real one is a single file read the UI wants
/// before its first paint — and making the fake async would change the timing
/// the tests are meant to pin.
private final class FakeSnapshots: SnapshotStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Snapshot?
    private(set) var writes = 0

    init(seed: Snapshot? = nil) { stored = seed }

    func read() -> Snapshot? {
        lock.withLock { stored }
    }

    func write(_ snapshot: Snapshot) {
        lock.withLock {
            stored = snapshot
            writes += 1
        }
    }

    func clear() {
        lock.withLock { stored = nil }
    }
}

/// A server that answers from a script, and records what it was asked.
private final class FakeServer: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var bootstrapCalls = 0
    private(set) var liveCalls = 0
    /// Set to fail every request, to drive the offline path.
    var failing = false
    /// Set to answer every request with this status instead of failing on the
    /// wire — the difference between "no route" and "the server is down",
    /// which the screens now word differently.
    var failingStatus: Int?
    /// Set to fail only `/live` — what a server without that route deployed
    /// yet actually does.
    var liveFailing = false
    var payload: LivePayload = LiveFixture.payload()

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path() ?? ""
            let shouldFail = lock.withLock { () -> Bool in
                if path.hasSuffix("/bootstrap") { bootstrapCalls += 1 }
                if path.hasSuffix("/live") { liveCalls += 1 }
                return failing || (liveFailing && path.hasSuffix("/live"))
            }

            if shouldFail { throw URLError(.notConnectedToInternet) }

            if let status = lock.withLock({ failingStatus }) {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (Data("{}".utf8), response)
            }

            let body: Data
            if path.hasSuffix("/bootstrap") {
                body = try JSONEncoder().encode(LiveFixture.bootstrap(live: lock.withLock { payload }))
            } else {
                body = try JSONEncoder().encode(lock.withLock { payload })
            }

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (body, response)
        }
    }
}

@MainActor
private func makeStore(
    server: FakeServer = FakeServer(),
    snapshots: FakeSnapshots = FakeSnapshots(),
    token: String? = "signed.token",
    connected: Bool = true
) -> LiveStore {
    let config = AppConfig(baseURL: URL(string: "https://example.test")!)
    return LiveStore(
        client: LiveClient(api: APIClient(config: config, transport: server.transport())),
        snapshots: snapshots,
        tokenProvider: { token },
        isConnected: { connected },
        // A throwaway domain per store. Swift Testing runs suites in parallel
        // and `UserDefaults.standard` is process-wide, so sharing it let one
        // test's remembered scope decide what another test opened on — which
        // is exactly how this surfaced: adding two unrelated suites reordered
        // the run and a passing assertion started failing.
        defaults: UserDefaults(suiteName: "test.\(UUID().uuidString)") ?? .standard
    )
}

@Suite("Live store")
@MainActor
struct LiveStoreTests {
    // MARK: - The scene gate

    @Test("a store nobody opened ignores the foreground")
    func scenePhaseIgnoredBeforeStart() async {
        // The shell tells every store the app came back, because a store that
        // only hears it while its own tab is on screen hears it almost never.
        // The price of moving the wiring up is that stores nobody has opened
        // must stay cold — otherwise unlocking the phone would fetch three
        // tabs the user has never visited.
        let server = FakeServer()
        let store = makeStore(server: server)

        store.scenePhaseChanged(toActive: true)
        await Task.yield()

        #expect(server.bootstrapCalls == 0)
        #expect(!store.hasStarted)
    }

    @Test("a store that has started refreshes when the app comes back")
    func scenePhaseRefreshesAfterStart() async {
        let server = FakeServer()
        let store = makeStore(server: server)

        await store.start()
        let afterStart = server.bootstrapCalls
        store.scenePhaseChanged(toActive: true)
        // The refresh is fired from a `Task`; wait for it to land rather than
        // guessing how long a loaded simulator takes to run it.
        await until { server.bootstrapCalls > afterStart }

        #expect(store.hasStarted)
        #expect(server.bootstrapCalls > afterStart)
    }

    // MARK: - Cold start

    @Test("paints from the snapshot before the network answers")
    func paintsFromSnapshot() async {
        let seeded = Snapshot(
            bootstrap: LiveFixture.bootstrap(live: LiveFixture.payload(totalValue: "999,00 PLN")),
            capturedAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
        let snapshots = FakeSnapshots(seed: seeded)
        let server = FakeServer()
        server.failing = true

        let store = makeStore(server: server, snapshots: snapshots)
        await store.start()

        // The network failed outright, so what is on screen can only have come
        // off disk — which is the entire justification for keeping a snapshot.
        #expect(store.visibleSummary?.totalValue == "999,00 PLN")
        #expect(!store.isLoading)
    }

    @Test("fetches both halves concurrently, not one after the other")
    func refreshesBothHalves() async {
        let server = FakeServer()
        let store = makeStore(server: server)

        await store.refresh()

        // Both were asked for. Sequentially this would pay a cold Vercel
        // function twice, and neither call needs the other's answer.
        #expect(server.bootstrapCalls == 1)
        #expect(server.liveCalls == 1)
        #expect(store.bootstrap != nil)
    }

    @Test("a successful refresh writes a snapshot carrying the fresher prices")
    func writesSnapshot() async {
        let snapshots = FakeSnapshots()
        let server = FakeServer()
        server.payload = LiveFixture.payload(totalValue: "111,00 PLN")

        let store = makeStore(server: server, snapshots: snapshots)
        await store.refresh()

        #expect(snapshots.writes == 1)
        #expect(snapshots.read()?.bootstrap.live.summary.totalValue == "111,00 PLN")
        #expect(store.capturedAt != nil)
    }

    @Test("a missing /live still paints — bootstrap carries a payload of its own")
    func liveFailureDegradesRatherThanBlanks() async {
        let server = FakeServer()
        server.liveFailing = true
        let store = makeStore(server: server)

        await store.refresh()

        // This is not hypothetical: `/live` shipped to the phone before it
        // shipped to the server, and awaiting both as a tuple turned one 404
        // into "Could not load your portfolio" over a perfectly good bootstrap.
        #expect(store.visibleSummary != nil)
        #expect(store.errorMessage == nil)
        #expect(!store.isOffline)
    }

    // MARK: - Offline honesty

    @Test("one failure is not offline; two are")
    func offlineNeedsTwoFailures() async {
        let server = FakeServer()
        let store = makeStore(server: server)

        await store.refresh()  // succeed, so there is something on screen
        server.failing = true

        await store.refresh()
        #expect(!store.isOffline, "a single failure is noise, not a verdict")

        await store.refresh()
        #expect(store.isOffline)
    }

    @Test("a recovered request clears the offline verdict")
    func recoveryClearsOffline() async {
        let server = FakeServer()
        let store = makeStore(server: server)
        server.failing = true
        await store.refresh()
        await store.refresh()
        #expect(store.isOffline)

        server.failing = false
        await store.refresh()
        #expect(!store.isOffline)
    }

    @Test("failing with nothing on screen is an error; failing with data is not")
    func errorOnlyWhenEmpty() async {
        let server = FakeServer()
        server.failing = true
        let store = makeStore(server: server)

        await store.refresh()
        // The fake fails with `.notConnectedToInternet`, so the screen says so
        // rather than blaming itself. A generic "could not load" under a Try
        // again button, offline, describes the wrong problem and then offers a
        // control that cannot solve it.
        #expect(store.errorMessage == LoadFailure.offline)
        #expect(!store.isLoading)

        // Once something has painted, a later failure is a staleness problem —
        // shouting "could not load" over a screen full of figures is a lie.
        server.failing = false
        await store.refresh()
        server.failing = true
        await store.refresh()
        #expect(store.errorMessage == nil)
    }

    @Test("a server failure keeps the generic message; only the radio gets the network one")
    func serverFailureIsNotOffline() async {
        let server = FakeServer()
        server.failingStatus = 503
        let store = makeStore(server: server)

        await store.refresh()

        // A 503 is the server having a bad minute, and telling the user their
        // connection is at fault would send them to restart a router that is
        // working fine.
        #expect(store.errorMessage == LiveStore.genericError)
    }

    @Test("a known-disconnected radio is stale from the first frame, not after two failures")
    func disconnectedIsImmediate() async {
        let server = FakeServer()
        server.failing = true
        let store = makeStore(server: server, connected: false)

        await store.refresh()

        // The counter would still be at one. The OS already knows, so waiting
        // for a second twenty-second timeout to say so is forty seconds of
        // silence the app does not need to keep.
        #expect(store.isOffline)
        #expect(store.freshness == .disconnected(since: nil))
    }

    @Test("a cold launch off a snapshot admits the figures are unconfirmed")
    func snapshotIsStaleUntilConfirmed() async {
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshots = FakeSnapshots(
            seed: Snapshot(bootstrap: LiveFixture.bootstrap(), capturedAt: taken)
        )
        let server = FakeServer()
        server.failing = true
        let store = makeStore(server: server, snapshots: snapshots)

        await store.start()

        // Painted, and honest about it. This used to read as `.fresh` until
        // two requests had failed — a launch in a tunnel showing yesterday's
        // money with no bar over it.
        #expect(store.bootstrap != nil)
        #expect(store.freshness == .stale(since: taken))
    }

    @Test("the network coming back reloads without anyone tapping anything")
    func connectivityRestoreRefreshes() async {
        let server = FakeServer()
        let store = makeStore(server: server)
        await store.start()
        let before = server.bootstrapCalls

        store.connectivityChanged(to: false)
        store.connectivityChanged(to: true)
        // The refresh is fired into a `Task`; wait for it to land.
        await until { server.bootstrapCalls > before }

        #expect(server.bootstrapCalls > before)
    }

    // MARK: - Scopes

    @Test("the chips are All plus each portfolio, in the portfolio's own order")
    func scopeChipOrder() async {
        let server = FakeServer()
        let store = makeStore(server: server)
        await store.refresh()

        let chips = store.scopeChips
        #expect(chips.first?.id == LiveStore.allScopeID)
        #expect(chips.map(\.name).contains("Main"))
    }

    @Test("selecting a scope reads that scope's own rows and summary")
    func scopeSelection() async {
        let scoped = LiveScope(
            holdings: [LiveFixture.holding(instrumentId: "i2")],
            id: "p1",
            summary: LiveFixture.summary(totalValue: "500,00 PLN")
        )
        let server = FakeServer()
        server.payload = LiveFixture.payload(
            holdings: [LiveFixture.holding(instrumentId: "i1"), LiveFixture.holding(instrumentId: "i2")],
            scopes: [scoped]
        )

        let store = makeStore(server: server)
        await store.refresh()

        store.selectedScopeID = LiveStore.allScopeID
        #expect(store.visibleHoldings.count == 2)
        // "All" must be the payload's own top level, never a client-side sum:
        // totals cross currencies through FX the server already applied.
        #expect(store.visibleSummary?.totalValue == "23 708,11 PLN")

        store.selectedScopeID = "p1"
        #expect(store.visibleHoldings.map(\.instrumentId) == ["i2"])
        #expect(store.visibleSummary?.totalValue == "500,00 PLN")
    }

    @Test("an unknown scope shows nothing rather than silently falling back to All")
    func unknownScope() async {
        let store = makeStore()
        await store.refresh()

        store.selectedScopeID = "deleted-portfolio"
        // Quietly showing every holding under a portfolio's name would be
        // worse than showing none: the figure would be wrong and look right.
        #expect(store.visibleHoldings.isEmpty)
    }

    @Test("all scope with rows is not empty")
    func holdingsEmptinessWithRows() async {
        let store = makeStore()
        await store.refresh()
        store.selectedScopeID = LiveStore.allScopeID

        #expect(store.holdingsEmptiness == .notEmpty)
    }

    @Test("no rows in any portfolio is account empty")
    func holdingsEmptinessWithNoRows() async {
        let server = FakeServer()
        server.payload = LiveFixture.payload(holdings: [])
        let store = makeStore(server: server)
        await store.refresh()

        #expect(store.holdingsEmptiness == .accountEmpty)
    }

    @Test("an empty selected portfolio names the scope when other holdings exist")
    func holdingsEmptinessNamesEmptyScope() async {
        let server = FakeServer()
        server.payload = LiveFixture.payload(
            holdings: [LiveFixture.holding(instrumentId: "i1")],
            scopes: [
                LiveScope(holdings: [], id: "p1", summary: LiveFixture.summary(totalValue: nil)),
            ]
        )
        let store = makeStore(server: server)
        await store.refresh()
        store.selectedScopeID = "p1"

        #expect(store.holdingsEmptiness == .scopeEmpty(portfolioName: "Main"))
    }

    @Test("an empty selected portfolio is account empty when all holdings are empty")
    func holdingsEmptinessTreatsEmptyAccountHonestly() async {
        let server = FakeServer()
        server.payload = LiveFixture.payload(
            holdings: [],
            scopes: [
                LiveScope(holdings: [], id: "p1", summary: LiveFixture.summary(totalValue: nil)),
            ]
        )
        let store = makeStore(server: server)
        await store.refresh()
        store.selectedScopeID = "p1"

        #expect(store.holdingsEmptiness == .accountEmpty)
    }

    @Test("a store without live data is account empty")
    func holdingsEmptinessBeforeLiveData() {
        let store = makeStore()

        #expect(store.holdingsEmptiness == .accountEmpty)
    }

    @Test("static rows are matched to live rows by instrument id")
    func matchesStatics() async throws {
        let server = FakeServer()
        let store = makeStore(server: server)
        await store.refresh()

        let holding = try #require(store.visibleHoldings.first)
        #expect(store.staticHolding(for: holding)?.symbol == "AAPL")
    }

    // MARK: - Sign-out

    @Test("purge clears the screen and the container a widget could read")
    func purgeClearsEverything() async {
        let snapshots = FakeSnapshots()
        let store = makeStore(snapshots: snapshots)
        await store.refresh()
        #expect(snapshots.read() != nil)

        store.purge()

        #expect(store.bootstrap == nil)
        #expect(store.visibleHoldings.isEmpty)
        // Leaving a portfolio on disk after sign-out would be the same mistake
        // as leaving the token in the Keychain.
        #expect(snapshots.read() == nil)
    }

    @Test("no token means no request at all")
    func withoutTokenDoesNothing() async {
        let server = FakeServer()
        let store = makeStore(server: server, token: nil)

        await store.refresh()

        #expect(server.bootstrapCalls == 0)
        #expect(server.liveCalls == 0)
    }
}
