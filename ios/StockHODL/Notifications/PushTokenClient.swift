import Foundation

/// `POST` / `DELETE /api/mobile/v1/push-token` — `PushTokenRequest` and
/// `PushTokenResponse` are generated (`pnpm contracts:gen`) from
/// `src/lib/api/contracts/push.ts`'s `pushTokenRequestSchema`, like every
/// other mobile contract.
struct PushTokenClient: Sendable {
    let api: APIClient

    func register(deviceToken: String, environment: PushTokenEnvironment, bearerToken: String) async throws {
        try await call(method: "POST", deviceToken: deviceToken, environment: environment, bearerToken: bearerToken)
    }

    func unregister(deviceToken: String, environment: PushTokenEnvironment, bearerToken: String) async throws {
        try await call(method: "DELETE", deviceToken: deviceToken, environment: environment, bearerToken: bearerToken)
    }

    /// `GET /api/mobile/v1/notification-preferences` — the two switches as
    /// the account remembers them. A missing server row answers both-off.
    func preferences(bearerToken: String) async throws -> NotificationPreferences {
        let response = try await api.send(APIRequest(
            path: "/api/mobile/v1/notification-preferences",
            bearerToken: bearerToken
        ))
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
        do {
            return try JSONDecoder().decode(NotificationPreferences.self, from: response.body)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// `PUT` — both booleans, always: a partial write would make "which
    /// switch did the phone mean" ambiguous.
    func updatePreferences(_ preferences: NotificationPreferences, bearerToken: String) async throws {
        let body = try JSONEncoder().encode(preferences)
        let response = try await api.send(APIRequest(
            method: "PUT",
            path: "/api/mobile/v1/notification-preferences",
            body: body,
            bearerToken: bearerToken
        ))
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
    }

    private func call(
        method: String,
        deviceToken: String,
        environment: PushTokenEnvironment,
        bearerToken: String
    ) async throws {
        let body = try JSONEncoder().encode(PushTokenRequest(environment: environment, token: deviceToken))
        let response = try await api.send(APIRequest(
            method: method,
            path: "/api/mobile/v1/push-token",
            body: body,
            bearerToken: bearerToken
        ))
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
    }
}
