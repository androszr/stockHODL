import Foundation
import Observation

/// The two Settings diagnostics the phone cannot work out for itself.
struct SettingsClient: Sendable {
    let api: APIClient

    /// One request, and a comparatively expensive one: the server runs a
    /// direct, UNCACHED vendor probe with its own 5 s timeout. Called when the
    /// screen opens, never polled — a health check that answers from cache is
    /// decorative, and one that answers every minute is a load test.
    func load(token: String) async throws -> SettingsResponse {
        try await api.decode(
            SettingsResponse.self,
            from: APIRequest(path: "/api/mobile/v1/settings", bearerToken: token)
        )
    }
}

/// Settings: is the price feed working, and is the server currently accepting
/// password sign-in.
///
/// Deliberately as dumb as the passkeys store: no poll, no stream, no
/// snapshot. It loads when the screen appears and on pull-to-refresh, and that
/// is the lifecycle.
@MainActor
@Observable
final class SettingsStore {
    private(set) var response: SettingsResponse?
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    static let genericError = "Could not check the market-data feed."

    private let client: SettingsClient
    private let tokenProvider: @MainActor () -> String?

    init(client: SettingsClient, tokenProvider: @escaping @MainActor () -> String?) {
        self.client = client
        self.tokenProvider = tokenProvider
    }

    func load() async {
        guard let token = tokenProvider() else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            response = try await client.load(token: token)
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[settings] load failed: \(error)")
            #endif
            errorMessage = SettingsStore.genericError
        }
    }

    func dismissError() { errorMessage = nil }

    func purge() {
        response = nil
        errorMessage = nil
    }
}

/// The words for a verdict — one plain sentence each, so a dead key stops
/// being invisible.
///
/// The TEXT carries the state; a token-coloured dot beside it is
/// reinforcement and never the only signal. Same three verdicts, same
/// wording, as `market-data-health.tsx`.
extension MarketDataHealth {
    var title: String {
        switch self {
        case .ok: "Working"
        case .unauthorized: "Key rejected"
        case .unreachable: "Unreachable"
        }
    }

    var detail: String {
        switch self {
        case .ok:
            "The market-data feed is answering with the configured key."
        case .unauthorized:
            "The market-data key is invalid or expired. Prices cannot refresh until it is replaced."
        case .unreachable:
            "The vendor did not answer; this is usually temporary."
        }
    }

    /// Reinforcement only. `textMuted` for "unreachable" rather than a warning
    /// colour: a vendor having a bad minute is not the same claim as a key
    /// that will never work again.
    var token: DesignToken {
        switch self {
        case .ok: Tokens.gain
        case .unauthorized: Tokens.loss
        case .unreachable: Tokens.textMuted
        }
    }
}
