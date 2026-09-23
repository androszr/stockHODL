import Foundation
import Testing

@testable import StockHODL

/// A portfolio-management server: scripted status codes, and a record of every
/// body it was sent. `@unchecked Sendable` over a lock, like every other fake
/// here — the transport closure is `@Sendable` and the assertions want plain
/// synchronous reads.
private final class FakePortfolioServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var methods: [String] = []
    private(set) var paths: [String] = []
    private(set) var reorderedIDs: [[String]] = []
    private(set) var names: [String] = []

    var status = 200
    /// The refusal sentence a 409 carries — a duplicate name, in practice.
    var errorMessage = "A portfolio with that name already exists."

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path() ?? ""
            let method = request.httpMethod ?? "GET"

            // Read as raw JSON rather than decoded: the request structs are
            // `Encodable` only, deliberately — nothing in the app ever decodes
            // one, and adding a conformance for a test's convenience would
            // make the wire shape look bidirectional when it is not.
            if let body = request.httpBody,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                lock.withLock {
                    if let ids = json["ids"] as? [String] { reorderedIDs.append(ids) }
                    if let name = json["name"] as? String { names.append(name) }
                }
            }

            let status = lock.withLock { () -> Int in
                methods.append(method)
                paths.append(path)
                return self.status
            }

            let payload: Data
            if status >= 400 {
                payload = try JSONEncoder().encode(["error": lock.withLock { errorMessage }])
            } else if path.hasSuffix("/portfolios"), method == "POST" {
                payload = try JSONEncoder().encode(PortfolioCreated(id: "new-id", ok: true))
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
private func makeStore(
    server: FakePortfolioServer,
    token: String? = "signed.token"
) -> PortfoliosStore {
    let config = AppConfig(baseURL: URL(string: "https://example.test")!)
    return PortfoliosStore(
        client: PortfoliosClient(api: APIClient(config: config, transport: server.transport())),
        tokenProvider: { token }
    )
}

@Suite("Portfolios store")
@MainActor
struct PortfoliosStoreTests {
    @Test("create answers with the server's id, so the caller selects the right chip")
    func createReturnsID() async {
        let server = FakePortfolioServer()
        let store = makeStore(server: server)

        let id = await store.create(name: "IKE")

        // The id is the SERVER's. Matching on a name would pick the wrong chip
        // the first time two portfolios shared one.
        #expect(id == "new-id")
        #expect(server.names == ["IKE"])
        #expect(store.errorMessage == nil)
    }

    @Test("a refusal is shown in the server's own words")
    func surfacesTheRefusal() async {
        let server = FakePortfolioServer()
        server.status = 409
        let store = makeStore(server: server)

        let id = await store.create(name: "Main")

        #expect(id == nil)
        // A duplicate name is the realistic 409 here, and the server's sentence
        // names the problem better than any generic one could.
        #expect(store.errorMessage == "A portfolio with that name already exists.")
    }

    @Test("a transport failure gets the generic message, not a silent success")
    func surfacesTransportFailure() async {
        let server = FakePortfolioServer()
        server.status = 500
        let store = makeStore(server: server)

        #expect(await store.rename(id: "p1", to: "Retirement") == false)
        #expect(store.errorMessage != nil)
    }

    @Test("a move submits the FULL resulting order, never a delta")
    func moveSubmitsWholeOrder() async {
        let server = FakePortfolioServer()
        let store = makeStore(server: server)

        #expect(await store.move(id: "b", by: -1, within: ["a", "b", "c"]))

        // The server refuses a partial or stale list rather than patching it:
        // holes and ties in `sortOrder` are worse than an error.
        #expect(server.reorderedIDs == [["b", "a", "c"]])
    }

    @Test("moving later shifts one slot, and the rest keep their order")
    func moveLater() async {
        let server = FakePortfolioServer()
        let store = makeStore(server: server)

        #expect(await store.move(id: "a", by: 1, within: ["a", "b", "c"]))
        #expect(server.reorderedIDs == [["b", "a", "c"]])
    }

    @Test("a move off either end is refused locally and spends no request")
    func moveOffTheEnd() async {
        let server = FakePortfolioServer()
        let store = makeStore(server: server)

        #expect(await store.move(id: "a", by: -1, within: ["a", "b"]) == false)
        #expect(await store.move(id: "b", by: 1, within: ["a", "b"]) == false)
        // An id the list does not contain is the stale-chip case and is
        // equally a no-op — never a reorder of a list it is not in.
        #expect(await store.move(id: "z", by: 1, within: ["a", "b"]) == false)

        #expect(server.reorderedIDs.isEmpty)
    }

    @Test("delete asks for exactly that portfolio")
    func deletes() async {
        let server = FakePortfolioServer()
        let store = makeStore(server: server)

        #expect(await store.delete(id: "p1"))

        #expect(server.methods == ["DELETE"])
        #expect(server.paths == ["/api/mobile/v1/portfolios/p1"])
    }

    @Test("no token means no request at all")
    func withoutAToken() async {
        let server = FakePortfolioServer()
        let store = makeStore(server: server, token: nil)

        #expect(await store.create(name: "IKE") == nil)
        #expect(server.methods.isEmpty)
    }
}

@Suite("Scope management menu")
struct ScopeManageMenuTests {
    @Test("the transaction count is pluralised, and 'All' has none to show")
    func transactionLabel() {
        #expect(ScopeManageMenu.transactionLabel(1) == "1 transaction")
        #expect(ScopeManageMenu.transactionLabel(12) == "12 transactions")
        // An empty portfolio still deserves a chip and an honest zero.
        #expect(ScopeManageMenu.transactionLabel(0) == "0 transactions")
        // "All" is a view of the set, not a member of it.
        #expect(ScopeManageMenu.transactionLabel(nil) == "")
    }
}
