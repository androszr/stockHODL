import Foundation

/// The signed-in user, as much of it as this client needs.
// `Encodable` as well as `Decodable` so the last confirmed identity can be
// written to `SessionUserCache` — see there for why a launch needs one.
struct SessionUser: Codable, Sendable {
    let id: String
    let email: String
    let name: String?
}

/// Better Auth answers both `verify-authentication` and `get-session` with
/// `{ session, user }`. Only the user half is read here; the session's expiry is
/// the server's business, and asking the server is the only honest way to know
/// whether a token still works.
struct SessionEnvelope: Decodable, Sendable {
    let user: SessionUser
}

/// The four calls that make up sign-in, session check and sign-out.
///
/// Kept apart from `AuthStore` so the protocol dance with the server can be
/// tested against a stubbed transport without touching observable UI state.
struct AuthClient: Sendable {
    let api: APIClient

    private enum Path {
        static let options = "/api/auth/passkey/generate-authenticate-options"
        static let verify = "/api/auth/passkey/verify-authentication"
        static let signInEmail = "/api/auth/sign-in/email"
        static let session = "/api/auth/get-session"
        static let signOut = "/api/auth/sign-out"
    }

    private struct SignInEmailBody: Encodable, Sendable {
        let email: String
        let password: String
    }

    /// Step one. Returns the options AND the cookies that came with them.
    ///
    /// The cookies are not incidental. Better Auth stores the challenge server
    /// side under a random token and hands the client that token in a SIGNED
    /// cookie; `verify-authentication` reads the cookie back to find which
    /// challenge this assertion answers, and without it fails with
    /// "challenge not found" — a message that sounds like an expiry and is
    /// actually a missing header.
    ///
    /// This is also the reason the ceremony carries cookies at all, in a client
    /// that otherwise refuses to: it is one short-lived value passed by hand
    /// between two calls, not a session hidden in `HTTPCookieStorage`.
    func authenticationOptions() async throws -> (options: PasskeyRequestOptions, cookies: [String: String]) {
        let response = try await api.send(APIRequest(path: Path.options))
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
        do {
            let options = try JSONDecoder().decode(PasskeyRequestOptions.self, from: response.body)
            return (options, response.cookies)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Step two. Returns the signed session token from `set-auth-token`.
    ///
    /// An empty token here is a specific, diagnosable failure rather than a
    /// generic one: the assertion was accepted (or the call would not be 2xx),
    /// but the response came back stripped, which means the request did not
    /// reach the server carrying `x-stockhodl-client: ios`.
    func verify(
        assertion: PasskeyAssertion,
        cookies: [String: String]
    ) async throws -> (token: String, user: SessionUser) {
        let body = try JSONEncoder().encode(VerifyAuthenticationBody(response: assertion))
        let response = try await api.send(APIRequest(
            method: "POST",
            path: Path.verify,
            body: body,
            cookies: cookies
        ))

        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
        guard let token = response.sessionToken, !token.isEmpty else {
            throw APIError.missingSessionToken
        }

        do {
            let envelope = try JSONDecoder().decode(SessionEnvelope.self, from: response.body)
            return (token, envelope.user)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Break-glass: `POST /api/auth/sign-in/email` while `RECOVERY_MODE=1`.
    ///
    /// Same missing-`set-auth-token` failure as `verify`. The native header
    /// and `Origin` already come from `APIClient`; this method does not invent
    /// a second client. When recovery is off, Better Auth refuses and the
    /// caller maps that to the generic error — there is no public probe.
    func signInWithEmail(
        email: String,
        password: String
    ) async throws -> (token: String, user: SessionUser) {
        let body = try JSONEncoder().encode(SignInEmailBody(email: email, password: password))
        let response = try await api.send(APIRequest(
            method: "POST",
            path: Path.signInEmail,
            body: body
        ))

        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
        guard let token = response.sessionToken, !token.isEmpty else {
            throw APIError.missingSessionToken
        }

        do {
            let envelope = try JSONDecoder().decode(SessionEnvelope.self, from: response.body)
            return (token, envelope.user)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Is this stored token still a session? `nil` means no — the server
    /// answers 200 with a JSON `null` body for an unknown or expired token, so
    /// a bare status check would read that as success.
    ///
    /// `bearer({ requireSignature: true })` on the server means the token sent
    /// here must be the signed form from `set-auth-token`. A raw session token
    /// is rejected, which is the point of the setting.
    func currentUser(token: String) async throws -> SessionUser? {
        let response = try await api.send(APIRequest(path: Path.session, bearerToken: token))

        if response.status == 401 { return nil }
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
        // A JSON `null` body decodes to a nil optional; anything else that
        // fails to decode is a real problem worth surfacing.
        do {
            return try JSONDecoder().decode(SessionEnvelope?.self, from: response.body)?.user
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Revoke the session server side. The caller purges the Keychain whether
    /// this succeeds or not — see `AuthStore.signOut`.
    func signOut(token: String) async throws {
        let response = try await api.send(APIRequest(
            method: "POST",
            path: Path.signOut,
            body: Data("{}".utf8),
            bearerToken: token
        ))
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
    }
}
