import Foundation
import Testing

@testable import StockHODL

/// The dividend form's server: records every body, scripts the status.
private final class FakeDividendServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var methods: [String] = []
    private(set) var paths: [String] = []
    /// Write bodies as raw JSON. Not decoded: the request structs are
    /// `Encodable` only, deliberately — nothing in the app decodes one, and a
    /// conformance added for a test would make the wire look bidirectional.
    /// Raw is also what lets a test assert what was OMITTED, which is the
    /// whole point of the optional fields.
    private(set) var writes: [[String: Any]] = []

    var status = 200
    var errorMessage = "Payment not found."
    var instruments: [DividendInstrument] = [
        DividendInstrument(currency: "USD", displayName: "Apple Inc.", id: "i1", symbol: "AAPL"),
    ]
    var portfolios: [DividendInstrumentListPortfolio] = [
        DividendInstrumentListPortfolio(id: "p1", name: "Main"),
    ]

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path() ?? ""
            let method = request.httpMethod ?? "GET"

            if let body = request.httpBody,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                lock.withLock { writes.append(json) }
            }

            let status = lock.withLock { () -> Int in
                methods.append(method)
                paths.append(path)
                return path.hasSuffix("/instruments") ? 200 : self.status
            }

            let payload: Data
            if path.hasSuffix("/instruments") {
                payload = try JSONEncoder().encode(
                    lock.withLock {
                        DividendInstrumentList(instruments: instruments, portfolios: portfolios)
                    }
                )
            } else if status >= 400 {
                payload = try JSONEncoder().encode(["error": lock.withLock { errorMessage }])
            } else {
                payload = Data(#"{"ok":true}"#.utf8)
            }

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!
            return (payload, response)
        }
    }
}

@MainActor
private func makeForm(
    server: FakeDividendServer,
    editing: String? = nil,
    isVendorRow: Bool = false,
    draft: DividendDraft = DividendDraft()
) -> DividendFormStore {
    let config = AppConfig(baseURL: URL(string: "https://example.test")!)
    return DividendFormStore(
        client: DividendsClient(api: APIClient(config: config, transport: server.transport())),
        tokenProvider: { "signed.token" },
        editing: editing,
        isVendorRow: isVendorRow,
        draft: draft
    )
}

/// A draft that passes every check, so each test can break exactly one thing.
private func validDraft() -> DividendDraft {
    var draft = DividendDraft()
    draft.portfolioId = "p1"
    draft.instrumentId = "i1"
    draft.currency = .usd
    draft.exDate = "2026-02-06"
    draft.payDate = "2026-02-13"
    draft.quantity = "100"
    draft.amountPerShare = "0.25"
    draft.grossAmount = "25"
    draft.withheldTax = "3.75"
    return draft
}

@Suite("Dividend draft")
struct DividendDraftTests {
    @Test("a complete draft has nothing to complain about")
    func validDraftPasses() {
        #expect(validDraft().issues().isEmpty)
    }

    @Test("the two identity fields are required before anything else matters")
    func requiresPortfolioAndInstrument() {
        var draft = validDraft()
        draft.portfolioId = ""
        draft.instrumentId = ""

        let issues = draft.issues()
        #expect(issues[.portfolioId] != nil)
        #expect(issues[.instrumentId] != nil)
    }

    @Test("withheld tax above the gross is refused — that is a typo, not a payment")
    func withheldCannotExceedGross() {
        var draft = validDraft()
        draft.grossAmount = "25"
        draft.withheldTax = "30"

        // Net would be negative. The one cross-field rule the schema states.
        #expect(draft.issues()[.withheldTax] != nil)
    }

    @Test("withheld tax equal to the gross is allowed — a fully withheld payment is real")
    func withheldMayEqualGross() {
        var draft = validDraft()
        draft.grossAmount = "25"
        draft.withheldTax = "25"

        #expect(draft.issues()[.withheldTax] == nil)
    }

    @Test("a blank withheld field is zero, not an error")
    func blankWithheldIsZero() {
        var draft = validDraft()
        draft.withheldTax = ""

        #expect(draft.issues()[.withheldTax] == nil)
        // Stated on the wire rather than left to a preprocess the client
        // cannot see.
        #expect(draft.createRequest()?.withheldTax == "0")
    }

    @Test("a pl-PL comma is accepted and normalised on the wire")
    func acceptsCommaSeparator() {
        var draft = validDraft()
        draft.amountPerShare = "0,25"

        #expect(draft.issues()[.amountPerShare] == nil)
        #expect(draft.createRequest()?.amountPerShare == "0.25")
    }

    @Test("an absent pay date and an unpublished rate are OMITTED, never empty strings")
    func optionalsAreOmitted() {
        var draft = validDraft()
        draft.payDate = ""
        draft.fxRateToBase = ""

        let request = draft.createRequest()
        // The server's `z.preprocess` turns "" into absent but refuses null;
        // JSONEncoder omits a nil, which is exactly the encoding it wants.
        #expect(request?.payDate == nil)
        #expect(request?.fxRateToBase == nil)
    }

    @Test("a note keeps its commas — it is text, not a decimal")
    func noteIsNotNormalised() {
        var draft = validDraft()
        draft.note = "3,50 per share, DRIP"

        #expect(draft.createRequest()?.note == "3,50 per share, DRIP")
    }

    @Test("an ex-date that is not a date is refused before the round trip")
    func rejectsBadDates() {
        var draft = validDraft()
        draft.exDate = "06/02/2026"

        #expect(draft.issues()[.exDate] != nil)
        #expect(draft.createRequest() == nil)
    }

    @Test("a negative or zero amount is refused")
    func rejectsNonPositiveAmounts() {
        var draft = validDraft()
        draft.quantity = "-10"
        draft.grossAmount = "0"

        #expect(draft.issues()[.quantity] != nil)
        #expect(draft.issues()[.grossAmount] != nil)
    }

    @Test("the edit body carries no instrument and no currency")
    func updateOmitsTheLockedFields() {
        // Both are locked server-side. Sending them would be a fiction the
        // handler merely happens to discard.
        let request = validDraft().updateRequest()
        #expect(request != nil)
        let json = try! JSONSerialization.jsonObject(
            with: try! JSONEncoder().encode(request)
        ) as! [String: Any]
        #expect(json["instrumentId"] == nil)
        #expect(json["currency"] == nil)
    }

    @Test("seeding from a stored payment keeps the RAW decimal strings")
    func seedsFromAPayment() {
        let payment = DividendPayment(
            amountPerShare: "0.25000000",
            currency: "USD",
            displayName: "Apple Inc.",
            edited: false,
            exDate: "2026-02-06",
            fxRateToBase: "4.05000000",
            grossAmount: "25.00000000",
            id: "d1",
            instrumentId: "i1",
            netAmount: "21.25000000",
            note: nil,
            payDate: "2026-02-13",
            portfolioId: "p1",
            portfolioName: "Main",
            quantity: "100.00000000",
            source: .manual,
            symbol: "AAPL",
            withheldTax: "3.75000000"
        )

        let draft = DividendDraft.editing(payment)
        // Raw, never a grouped "25,00 $" that would have to be parsed back —
        // parsing money back is how a rounding difference is introduced.
        #expect(draft.grossAmount == "25.00000000")
        #expect(draft.currency == .usd)
        #expect(draft.issues().isEmpty)
    }
}

@Suite("Dividend form store")
@MainActor
struct DividendFormStoreTests {
    @Test("the two dropdowns arrive in one request")
    func loadsOptionsOnce() async {
        let server = FakeDividendServer()
        let store = makeForm(server: server)

        await store.loadOptions()

        #expect(store.instruments.count == 1)
        #expect(store.portfolios.count == 1)
        #expect(server.paths == ["/api/mobile/v1/dividends/instruments"])
    }

    @Test("one portfolio is pre-selected rather than hidden behind a picker")
    func preSelectsTheOnlyPortfolio() async {
        let server = FakeDividendServer()
        let store = makeForm(server: server)

        await store.loadOptions()

        #expect(store.draft.portfolioId == "p1")
    }

    @Test("nothing to attach to is a real answer, not an empty picker")
    func nothingToAttachTo() async {
        let server = FakeDividendServer()
        server.instruments = []
        let store = makeForm(server: server)

        await store.loadOptions()

        // A payment attaches to a stock the ledger already knows about, and
        // this path can never mint one.
        #expect(store.hasNothingToAttachTo)
    }

    @Test("picking an instrument sets the currency with it")
    func currencyFollowsTheInstrument() async {
        let server = FakeDividendServer()
        server.instruments = [
            DividendInstrument(currency: "EUR", displayName: "ASML", id: "i2", symbol: "ASML"),
        ]
        let store = makeForm(server: server)
        await store.loadOptions()

        store.choose(instrumentId: "i2")

        // One choice, not two: letting them drift apart would file a payment
        // in money the stock does not trade in.
        #expect(store.draft.currency == .eur)
    }

    @Test("saving a new payment POSTs the validated draft")
    func createsAPayment() async {
        let server = FakeDividendServer()
        let store = makeForm(server: server, draft: validDraft())

        await store.save()

        #expect(store.didSave)
        #expect(server.methods.contains("POST"))
        #expect(server.writes.first?["grossAmount"] as? String == "25")
    }

    @Test("saving an edit PATCHes that payment")
    func updatesAPayment() async {
        let server = FakeDividendServer()
        let store = makeForm(server: server, editing: "d1", draft: validDraft())

        await store.save()

        #expect(store.didSave)
        #expect(server.paths.contains("/api/mobile/v1/dividends/d1"))
        // The instrument and the currency are locked server-side; sending them
        // would be a fiction the handler merely happens to discard.
        #expect(server.writes.count == 1)
        #expect(server.writes[0]["instrumentId"] == nil)
    }

    @Test("submitting an invalid draft shows every refusal and spends no request")
    func submitTouchesEverything() async {
        let server = FakeDividendServer()
        var draft = validDraft()
        draft.grossAmount = "-1"
        let store = makeForm(server: server, draft: draft)

        await store.save()

        // A refusal the user has not seen yet is exactly what they need now.
        #expect(store.issues[.grossAmount] != nil)
        #expect(!store.didSave)
        #expect(server.methods.isEmpty)
    }

    @Test("the server's refusal is shown in its own words")
    func surfacesTheServerRefusal() async {
        let server = FakeDividendServer()
        server.status = 409
        server.errorMessage =
            "A fetched payment can't move to another portfolio — the next refresh would re-create it in the old one."
        let store = makeForm(server: server, editing: "d1", isVendorRow: true, draft: validDraft())

        await store.save()

        #expect(!store.didSave)
        // The portfolio lock tells the user something the form cannot work out.
        #expect(store.errorMessage?.contains("re-create it in the old one") == true)
    }

    @Test("issues stay hidden until a field has been left")
    func issuesFollowTouch() {
        let server = FakeDividendServer()
        var draft = validDraft()
        draft.quantity = "-5"
        let store = makeForm(server: server, draft: draft)

        // A form must not open covered in red before a character is typed.
        #expect(store.issue(for: .quantity) == nil)

        store.markTouched(.quantity)
        #expect(store.issue(for: .quantity) != nil)
        // …but Save still knows better than the touched set.
        #expect(!store.canSave)
    }
}
