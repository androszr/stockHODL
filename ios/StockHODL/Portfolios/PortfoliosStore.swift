import Foundation
import Observation

/// Portfolio management — create, rename, reorder, delete.
///
/// It deliberately holds NO list. The chip row is built from the bootstrap
/// payload `LiveStore` already owns, and a second copy here would give the app
/// two answers to "what are my portfolios" that could disagree the moment one
/// of them refreshed. This store is the four writes plus the state a button
/// needs (busy, error), and after every successful write the caller refreshes
/// the one source.
///
/// The web's rules, unchanged, because they are the server's: a duplicate name
/// is refused with the server's own sentence, a reorder submits the FULL id
/// list (never a delta), and a delete takes the portfolio's transactions with
/// it — which is why the confirmation names the count.
@MainActor
@Observable
final class PortfoliosStore {
    /// True while a write is in flight. One flag rather than one per action:
    /// the menu disables as a whole, and two concurrent portfolio writes are
    /// not something to support — the second would race the first's reorder.
    private(set) var isBusy = false
    private(set) var errorMessage: String?

    private let client: PortfoliosClient
    private let tokenProvider: @MainActor () -> String?
    /// The OS's view of the radio — see `LiveStore` for why it is injected.
    private let isConnected: @MainActor () -> Bool

    init(
        client: PortfoliosClient,
        tokenProvider: @escaping @MainActor () -> String?,
        isConnected: @escaping @MainActor () -> Bool = { true }
    ) {
        self.isConnected = isConnected
        self.client = client
        self.tokenProvider = tokenProvider
    }

    /// Creates and returns the new id, or nil when the write failed. The id is
    /// the server's, so the caller can select exactly the chip it just made
    /// rather than matching on a name that may not be unique on screen yet.
    @discardableResult
    func create(name: String) async -> String? {
        await write { client, token in try await client.create(name: name, token: token) }
    }

    @discardableResult
    func rename(id: String, to name: String) async -> Bool {
        await write { client, token in
            try await client.rename(id: id, to: name, token: token)
            return true
        } != nil
    }

    /// Move one portfolio one slot, submitting the whole resulting order.
    ///
    /// Move earlier / move later rather than a drag, the same call the web
    /// makes: dragging pills inside a horizontally scrolling row fights the
    /// scroll gesture, and with a handful of portfolios one menu tap per slot
    /// is the cheaper interaction.
    @discardableResult
    func move(id: String, by delta: Int, within ordered: [String]) async -> Bool {
        guard let index = ordered.firstIndex(of: id) else { return false }
        let target = index + delta
        guard target >= 0, target < ordered.count else { return false }

        var next = ordered
        let moved = next.remove(at: index)
        next.insert(moved, at: target)

        return await write { client, token in
            try await client.reorder(ids: next, token: token)
            return true
        } != nil
    }

    @discardableResult
    func delete(id: String) async -> Bool {
        await write { client, token in
            try await client.delete(id: id, token: token)
            return true
        } != nil
    }

    func dismissError() { errorMessage = nil }

    /// The one place a write's plumbing lives: token, busy flag, and the
    /// server's own refusal sentence.
    ///
    /// A 409 here is not a malformed request — it is a duplicate name or a
    /// reorder against a list the server no longer recognises, and in both
    /// cases the server's message is the one worth showing. A transport
    /// failure has no sentence of its own and gets a generic one.
    private func write<T>(
        _ body: (PortfoliosClient, String) async throws -> T
    ) async -> T? {
        guard let token = tokenProvider() else { return nil }
        isBusy = true
        defer { isBusy = false }

        do {
            let result = try await body(client, token)
            errorMessage = nil
            return result
        } catch let APIError.http(_, message) {
            errorMessage = message ?? PortfoliosStore.genericError
            return nil
        } catch {
            #if DEBUG
                print("[portfolios] write failed: \(error)")
            #endif
            errorMessage = LoadFailure.writeMessage(
                for: error,
                connected: isConnected(),
                generic: PortfoliosStore.genericError
            ) ?? PortfoliosStore.genericError
            return nil
        }
    }

    static let genericError = "Could not save that. Try again."
}
