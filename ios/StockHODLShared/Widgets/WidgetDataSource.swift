import Foundation

/// What a widget got when it asked, in the only three shapes a widget can
/// actually draw.
///
/// `stale` rather than a second case for cached data: every renderer has to
/// handle both, and splitting them into separate cases would duplicate the
/// whole view for a difference that amounts to one caption. `capturedAt` is
/// non-nil exactly when the figures came from the cache.
enum WidgetLoadOutcome: Sendable, Equatable {
    /// Fresh from the server, or the last cached payload when it was not.
    case figures(WidgetSummaryResponse, capturedAt: Date?)
    /// No token anywhere. The widget says so and deep-links into the app —
    /// a passkey ceremony needs a user, and nothing here has one.
    case signedOut
    /// A first run with no network and nothing cached. The one honest blank.
    case unavailable

    var payload: WidgetSummaryResponse? {
        if case let .figures(payload, _) = self { return payload }
        return nil
    }
}

// `WidgetSummaryResponse` is generated and has no synthesised `Equatable`;
// comparing the two summaries and the market block is enough for a test to
// say which payload an outcome carries.
extension WidgetSummaryResponse: Equatable {
    static func == (lhs: WidgetSummaryResponse, rhs: WidgetSummaryResponse) -> Bool {
        lhs.holdings.totalValue == rhs.holdings.totalValue
            && lhs.options.totalValue == rhs.options.totalValue
            && lhs.market.serverNowMs == rhs.market.serverNowMs
    }
}

/// The one place a widget gets its numbers.
///
/// The order is the whole design:
///
///   1. no token → `.signedOut`, immediately, WITHOUT a request. A widget that
///      cannot be signed in must not spend its refresh budget discovering that
///      again every fifteen minutes;
///   2. fetch `/api/mobile/v1/widget` — one small request, never the two big
///      screens' routes;
///   3. on success, cache it and answer fresh;
///   4. on ANY failure — transport, 5xx, a decode — answer the cache with its
///      age attached. A widget showing this morning's close is useful; a
///      widget showing a placeholder because a tunnel ate one request is not;
///   5. a 401 is the exception: the session is genuinely gone, and continuing
///      to show cached money beside a dead session would be a lie the user
///      cannot act on. That answers `.signedOut` and clears nothing — the
///      cache stays for the moment they sign back in.
struct WidgetDataSource: Sendable {
    let api: APIClient
    let tokens: TokenStore
    let cache: WidgetCaching

    init(
        api: APIClient = APIClient(config: .current),
        tokens: TokenStore = MigratingTokenStore(),
        cache: WidgetCaching = AppGroupWidgetCache()
    ) {
        self.api = api
        self.tokens = tokens
        self.cache = cache
    }

    func load(now: Date) async -> WidgetLoadOutcome {
        guard let token = try? tokens.read(), !token.isEmpty else { return .signedOut }

        do {
            let payload = try await api.decode(
                WidgetSummaryResponse.self,
                from: APIRequest(path: "/api/mobile/v1/widget", bearerToken: token)
            )
            cache.write(CachedWidgetPayload(payload: payload, capturedAt: now))
            return .figures(payload, capturedAt: nil)
        } catch APIError.http(status: 401, message: _) {
            return .signedOut
        } catch {
            guard let cached = cache.read() else { return .unavailable }
            return .figures(cached.payload, capturedAt: cached.capturedAt)
        }
    }
}
