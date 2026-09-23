import Foundation
import Testing

@testable import StockHODL

private final class FakeChainServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var expirationCalls = 0
    private(set) var strikeCalls = 0
    private(set) var strikeQueries: [String] = []
    private(set) var expirationQueries: [String] = []
    private(set) var writes: [(method: String, path: String, body: Data?)] = []

    var expirations: [OptionExpiry] = [
        OptionExpiry(expirationDate: "2026-09-04", label: "4 wrz 2026"),
        OptionExpiry(expirationDate: "2026-10-16", label: "16 paź 2026"),
    ]
    var contracts: [OptionContractRef] = [
        OptionContractRef(
            contractType: .call,
            expirationDate: "2026-09-04",
            sharesPerContract: "100",
            strikeLabel: "220",
            strikePrice: "220.00000000",
            ticker: "O:AAPL260904C00220000",
            underlying: "AAPL"
        )
    ]
    var chainFails = false

    /// Callers parked until the expirations count reaches their target —
    /// resumed by the transport itself, so a test waits on the event, not on
    /// a clock.
    private var expirationWaiters: [(target: Int, continuation: CheckedContinuation<Void, Never>)] = []

    /// Returns once `expirationCalls` has reached `count`. A lookup that
    /// already hopped off the main actor lands on the transport a moment
    /// later; this awaits exactly that landing.
    func waitForExpirationCalls(_ count: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let reached = lock.withLock { () -> Bool in
                if expirationCalls >= count { return true }
                expirationWaiters.append((target: count, continuation: continuation))
                return false
            }
            if reached { continuation.resume() }
        }
    }

    func transport() -> APIClient.Transport {
        { [self] request in
            let url = request.url!
            let path = url.path()
            let method = request.httpMethod ?? "GET"

            if method != "GET" {
                lock.withLock {
                    writes.append((method: method, path: path, body: request.httpBody))
                }
                return (Data(#"{"ok":true}"#.utf8), Self.response(url, 200))
            }

            if path.hasSuffix("/expirations") {
                let (fails, list, ready) = lock.withLock {
                    () -> (Bool, [OptionExpiry], [CheckedContinuation<Void, Never>]) in
                    expirationCalls += 1
                    expirationQueries.append(url.query() ?? "")
                    let count = expirationCalls
                    let ready = expirationWaiters.filter { $0.target <= count }.map(\.continuation)
                    expirationWaiters.removeAll { $0.target <= count }
                    return (chainFails, expirations, ready)
                }
                for continuation in ready { continuation.resume() }
                if fails {
                    return (
                        Data(#"{"ok":false,"degraded":true,"reason":"unavailable"}"#.utf8),
                        Self.response(url, 200)
                    )
                }
                let body = try JSONEncoder().encode(
                    OptionExpirationsResponse(expirations: list, ok: true, degraded: nil, reason: nil)
                )
                return (body, Self.response(url, 200))
            }

            if path.hasSuffix("/strikes") {
                let list = lock.withLock { () -> [OptionContractRef] in
                    strikeCalls += 1
                    strikeQueries.append(url.query() ?? "")
                    return contracts
                }
                let body = try JSONEncoder().encode(
                    OptionStrikesResponse(contracts: list, ok: true, degraded: nil, reason: nil)
                )
                return (body, Self.response(url, 200))
            }

            return (try JSONEncoder().encode(LiveFixture.optionsPayload()), Self.response(url, 200))
        }
    }

    private static func response(_ url: URL, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

/// A debounce pause the test ends by hand. Each lookup that reaches its pause
/// parks here until `endPauses()`; a lookup cancelled while parked is woken
/// with `CancellationError`, exactly as `Task.sleep` would wake it. No clock
/// anywhere, so a loaded machine cannot let a pause run out early.
@MainActor
private final class ManualPause {
    /// How many lookups reached their pause.
    private(set) var started = 0
    private var parked: [Int: CheckedContinuation<Void, Error>] = [:]

    func pause(_: Duration) async throws {
        started += 1
        let id = started
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    parked[id] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor in self.wake(id) }
        }
    }

    /// Ends every pause still running.
    func endPauses() {
        let running = parked
        parked = [:]
        for continuation in running.values { continuation.resume() }
    }

    private func wake(_ id: Int) {
        parked.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

/// Lets the lookup task a keystroke just scheduled run up to its first
/// suspension. The main actor is a serial FIFO: the task was enqueued before
/// this yield, so it runs before the test resumes. A few yields, not one, so
/// a hop inside the task's first step cannot outrun the next keystroke.
@MainActor
private func yieldToScheduledLookup() async {
    for _ in 0..<3 { await Task.yield() }
}

/// No debounce by default: every test but the debounce one is about what the
/// cascade DOES, and awaits it through `settleChain()` rather than a clock.
@MainActor
private func makeForm(
    _ mode: OptionFormStore.Mode,
    _ server: FakeChainServer,
    debounce: Duration = .zero,
    pause: ManualPause? = nil
) -> OptionFormStore {
    let debouncePause: OptionFormStore.DebouncePause
    if let pause {
        debouncePause = { duration in try await pause.pause(duration) }
    } else {
        debouncePause = OptionFormStore.sleepPause
    }
    return OptionFormStore(
        mode: mode,
        client: OptionsClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        tokenProvider: { "t" },
        lookupDebounce: debounce,
        debouncePause: debouncePause
    )
}

@MainActor
private func makeOptionsStore(_ server: FakeChainServer) -> OptionsStore {
    OptionsStore(
        client: OptionsClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        tokenProvider: { "t" }
    )
}

@Suite("Option form — the cascade")
@MainActor
struct OptionCascadeTests {
    @Test("typing an underlying fetches its expirations, debounced")
    func expirationsLoad() async {
        let server = FakeChainServer()
        let form = makeForm(.add, server)

        form.underlying = "AAPL"
        // Awaits the lookup task itself — neither a fixed sleep nor a polled
        // deadline, both of which report the machine's load average rather
        // than the code.
        await form.settleChain()

        #expect(server.expirationCalls == 1)
        #expect(form.expirations.count == 2)
    }

    /// Each lookup is a paid upstream call — the vendor is asked once the
    /// typing stops, not once per keystroke.
    @Test("four keystrokes in a row cause one lookup, not four")
    func debounces() async {
        let server = FakeChainServer()
        // A pause that lasts until the test ends it: every keystroke below
        // lands while the previous lookup is still waiting, whatever the
        // machine's load — no wall clock decides it.
        let pause = ManualPause()
        let form = makeForm(.add, server, debounce: OptionFormStore.lookupDebounce, pause: pause)

        // Each keystroke yields the main actor so the lookup it scheduled
        // actually STARTS and parks in its pause before the next keystroke
        // cancels it. Without the pause every one of those started lookups
        // would reach the vendor — the companion test below proves the
        // rhythm is enough for that.
        for text in ["A", "AA", "AAP", "AAPL"] {
            form.underlying = text
            await yieldToScheduledLookup()
        }
        // Every keystroke's lookup asked for its pause: a store that skipped
        // the debounce would never have asked. That each one then waited
        // instead of reaching the vendor is what the one-call check proves.
        #expect(pause.started == 4)

        pause.endPauses()
        await form.settleChain()

        #expect(server.expirationCalls == 1)
        // …and the one that survived is the last keystroke's.
        #expect(server.expirationQueries.first?.contains("AAPL") == true)
    }

    /// The control for the test above: the same keystroke rhythm with no
    /// pause reaches the vendor once per keystroke, so the one-lookup result
    /// there is the debounce's doing, not the rhythm's.
    @Test("with no pause, the same four keystrokes cause four lookups", .timeLimit(.minutes(1)))
    func noDebounceControl() async {
        let server = FakeChainServer()
        let form = makeForm(.add, server, debounce: .zero)

        for text in ["A", "AA", "AAP", "AAPL"] {
            form.underlying = text
            await yieldToScheduledLookup()
        }
        await form.settleChain()
        // The earlier lookups hopped off the main actor before they were
        // cancelled; wait for them to land on the transport, not for a clock.
        await server.waitForExpirationCalls(4)

        #expect(server.expirationCalls == 4)
    }

    /// A strike list has no meaning without an expiry, and offering one would
    /// invite picking a contract that does not exist.
    @Test("strikes are fetched only once an expiry is chosen")
    func strikesGatedOnExpiry() async {
        let server = FakeChainServer()
        let form = makeForm(.add, server)

        form.underlying = "AAPL"
        await form.settleChain()
        #expect(server.strikeCalls == 0)

        form.selectedExpiration = "2026-09-04"
        await form.settleChain()

        #expect(server.strikeCalls == 1)
        let query = try! #require(server.strikeQueries.first)
        #expect(query.contains("expirationDate=2026-09-04"))
        #expect(query.contains("contractType=call"))
    }

    /// A different underlying invalidates everything downstream — leaving a
    /// strike that belonged to another stock is how a contract for the wrong
    /// company gets tracked.
    @Test("changing the underlying clears the expiry, the strikes and the choice")
    func changingUnderlyingResetsDownstream() async {
        let server = FakeChainServer()
        let form = makeForm(.add, server)

        form.underlying = "AAPL"
        await form.settleChain()
        form.selectedExpiration = "2026-09-04"
        await form.settleChain()
        form.selectedTicker = "O:AAPL260904C00220000"
        #expect(form.selectedContract != nil)

        form.underlying = "MSFT"

        #expect(form.selectedExpiration == nil)
        #expect(form.selectedTicker == nil)
        #expect(form.strikes.isEmpty)
        #expect(form.expirations.isEmpty)
    }

    @Test("switching call to put refetches the strikes and clears the choice")
    func typeSwitchRefetches() async {
        let server = FakeChainServer()
        let form = makeForm(.add, server)
        form.underlying = "AAPL"
        await form.settleChain()
        form.selectedExpiration = "2026-09-04"
        await form.settleChain()
        form.selectedTicker = "O:AAPL260904C00220000"

        form.contractType = "put"
        await form.settleChain()

        #expect(form.selectedTicker == nil)
        #expect(server.strikeCalls == 2)
        #expect(server.strikeQueries.last?.contains("contractType=put") == true)
    }

    /// "The lookup is broken" and "there is nothing there" are different
    /// answers, and a vendor hiccup must leave the form usable.
    @Test("a degraded lookup says so and does not take the form down")
    func degradedIsNotFatal() async {
        let server = FakeChainServer()
        server.chainFails = true
        let form = makeForm(.add, server)

        form.underlying = "AAPL"
        await form.settleChain()

        #expect(form.chainDegraded)
        #expect(form.expirations.isEmpty)
        #expect(form.errorMessage == nil)
    }
}

@Suite("Option form — validation and save")
@MainActor
struct OptionFormValidationTests {
    /// The edit form prefills from the RAW strings. Prefilling from the
    /// formatted twins would either fail validation or, worse, silently parse
    /// "5,20 USD" down to 5.
    @Test("edit mode prefills the raw lot fields, never the formatted ones")
    func editPrefillsRaw() {
        let server = FakeChainServer()
        let lot = LiveFixture.optionLot(quantityRaw: "2.00000000", entryPriceRaw: "3.50000000")
        let form = makeForm(.edit(lot), server)

        #expect(form.quantity == "2.00000000")
        #expect(form.entryPrice == "3.50000000")
        #expect(form.tradeDate == "2026-08-10")
        #expect(form.editingLotID == lot.id)
    }

    @Test("add mode refuses to save without a chosen contract")
    func addNeedsAContract() {
        let server = FakeChainServer()
        let form = makeForm(.add, server)
        form.quantity = "2"
        form.entryPrice = "3.50"
        form.tradeDate = "2026-08-10"

        #expect(!form.isValid)
        form.markTouched(.contract)
        #expect(form.visibleIssue(.contract) != nil)
    }

    /// The same bounds `optionPositionAddSchema` applies — a rule that reads
    /// differently in two places is a rule the user has to learn twice.
    @Test("quantity and entry price must be greater than zero")
    func positiveOnly() {
        let server = FakeChainServer()
        let form = makeForm(.edit(LiveFixture.optionLot()), server)

        form.quantity = "0"
        form.entryPrice = "-1"
        form.validate()

        #expect(form.issues[.quantity] != nil)
        #expect(form.issues[.entryPrice] != nil)
    }

    /// A Polish keyboard types a comma. The server normalises the FIRST comma
    /// only, and so does this.
    @Test("a comma decimal separator is accepted, a grouped number is not")
    func commaSeparator() {
        let server = FakeChainServer()
        let form = makeForm(.edit(LiveFixture.optionLot()), server)

        form.quantity = "2"
        form.entryPrice = "3,50"
        form.tradeDate = "2026-08-10"
        form.validate()
        #expect(form.issues[.entryPrice] == nil)

        form.entryPrice = "1 000,50"
        form.validate()
        #expect(form.issues[.entryPrice] != nil)
    }

    /// Empty costs means zero, matching the server's own `preprocess`.
    /// Sending "" would be a 400 the web form never provokes.
    @Test("empty costs are valid and go out as zero")
    func emptyFeesAreZero() async {
        let server = FakeChainServer()
        let store = makeOptionsStore(server)
        let form = makeForm(.edit(LiveFixture.optionLot()), server)

        form.quantity = "2"
        form.entryPrice = "3.50"
        form.tradeDate = "2026-08-10"
        form.fees = ""
        #expect(form.isValid)

        await form.save(into: store)

        let write = try! #require(server.writes.first)
        let body = try! JSONSerialization.jsonObject(with: write.body!) as! [String: Any]
        #expect(body["fees"] as? String == "0")
    }

    /// The edit body is LOT FIELDS ONLY. Contract identity is refused by the
    /// server's strict schema, so it must never be sent — a `ticker` here
    /// would turn every edit into a 400.
    @Test("the edit body carries no contract identity")
    func editBodyIsLotOnly() async {
        let server = FakeChainServer()
        let store = makeOptionsStore(server)
        let lot = LiveFixture.optionLot()
        let form = makeForm(.edit(lot), server)

        form.quantity = "3"
        form.entryPrice = "4.10"
        form.tradeDate = "2026-08-12"
        await form.save(into: store)

        let write = try! #require(server.writes.first)
        #expect(write.method == "PATCH")
        #expect(write.path == "/api/mobile/v1/options/\(lot.id)")

        let body = try! JSONSerialization.jsonObject(with: write.body!) as! [String: Any]
        #expect(Set(body.keys) == ["id", "quantity", "entryPrice", "tradeDate", "fees"])
        #expect(body["ticker"] == nil)
    }

    /// Contract identity comes from the VENDOR ref, never from typed text: a
    /// strike the user invented would name a contract that does not exist.
    @Test("the add body takes its identity from the vendor contract")
    func addBodyUsesVendorIdentity() async {
        let server = FakeChainServer()
        let store = makeOptionsStore(server)
        let form = makeForm(.add, server)

        form.underlying = "AAPL"
        await form.settleChain()
        form.selectedExpiration = "2026-09-04"
        await form.settleChain()
        form.selectedTicker = "O:AAPL260904C00220000"
        form.quantity = "2"
        form.entryPrice = "3.50"
        form.tradeDate = "2026-08-10"

        await form.save(into: store)

        let write = try! #require(server.writes.first { $0.method == "POST" })
        let body = try! JSONSerialization.jsonObject(with: write.body!) as! [String: Any]
        #expect(body["ticker"] as? String == "O:AAPL260904C00220000")
        #expect(body["strikePrice"] as? String == "220.00000000")
        #expect(body["sharesPerContract"] as? String == "100")
        #expect(body["contractType"] as? String == "call")
    }

    @Test("an invalid form does not reach the network")
    func invalidDoesNotSave() async {
        let server = FakeChainServer()
        let store = makeOptionsStore(server)
        let form = makeForm(.edit(LiveFixture.optionLot()), server)

        form.quantity = "not a number"
        await form.save(into: store)

        #expect(server.writes.isEmpty)
        #expect(!form.didSave)
    }
}
