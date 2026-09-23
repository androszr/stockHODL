import Foundation

/// The enrolled-credential list, plus register and remove.
///
/// Registration is a WebAuthn ceremony against the Better Auth plugin's
/// existing generate-register-options / verify-registration endpoints — the
/// same family as assertion. Challenge cookies are forwarded by hand, same
/// as `AuthClient.verify`.
struct PasskeysClient: Sendable {
    let api: APIClient

    private enum Path {
        static let list = "/api/mobile/v1/passkeys"
        static let registerOptions = "/api/auth/passkey/generate-register-options"
        static let verifyRegistration = "/api/auth/passkey/verify-registration"
    }

    func list(token: String) async throws -> PasskeysResponse {
        try await api.decode(
            PasskeysResponse.self,
            from: APIRequest(path: Path.list, bearerToken: token)
        )
    }

    /// Step one of enrollment. Returns the options AND the cookies that came
    /// with them — the plugin stores the challenge under a signed cookie, and
    /// verify-registration reads it back.
    func registrationOptions(
        token: String,
        name: String
    ) async throws -> (options: PasskeyRegistrationOptions, cookies: [String: String]) {
        let response = try await api.send(APIRequest(
            path: Path.registerOptions,
            query: ["name": name],
            bearerToken: token
        ))
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
        do {
            let options = try JSONDecoder().decode(PasskeyRegistrationOptions.self, from: response.body)
            return (options, response.cookies)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Step two of enrollment. Session bearer + challenge cookies, same as
    /// assertion. The body is `{ response, name }` — SimpleWebAuthn's shape.
    func verifyRegistration(
        attestation: PasskeyAttestation,
        name: String,
        cookies: [String: String],
        token: String
    ) async throws {
        let body = try JSONEncoder().encode(
            VerifyRegistrationBody(response: attestation, name: name)
        )
        let response = try await api.send(APIRequest(
            method: "POST",
            path: Path.verifyRegistration,
            body: body,
            cookies: cookies,
            bearerToken: token
        ))
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
    }

    /// Throws `APIError.http` on the server's refusals, which are the point
    /// here rather than an edge case: 409 is "this is your only passkey" and
    /// 404 is "that key is already gone". Both carry a sentence worth showing.
    func remove(id: String, token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "DELETE",
                path: "\(Path.list)/\(id)",
                bearerToken: token
            )
        )
    }
}
