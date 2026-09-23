import Foundation

/// The two JSON shapes the passkey *registration* ceremony exchanges with
/// Better Auth. Hand-written for the same reason as `WebAuthn.swift`: this is
/// WebAuthn Level 2 JSON, not our contract. Every binary field is base64url.
///
/// Kept in its own file so `WebAuthn.swift` stays assertion-only.

// MARK: - What the server sends

/// `GET /api/auth/passkey/generate-register-options`.
///
/// Only the fields this client acts on are decoded.
struct PasskeyRegistrationOptions: Decodable, Sendable {
    let challenge: String
    let rp: RelyingParty
    let user: User
    let excludeCredentials: [ExcludedCredential]?
    let timeout: Int?
    let authenticatorSelection: AuthenticatorSelection?

    struct RelyingParty: Decodable, Sendable {
        let name: String
        let id: String?
    }

    struct User: Decodable, Sendable {
        let id: String
        let name: String
        let displayName: String
    }

    struct ExcludedCredential: Decodable, Sendable {
        let id: String
        let type: String?
        let transports: [String]?
    }

    struct AuthenticatorSelection: Decodable, Sendable {
        let authenticatorAttachment: String?
        let requireResidentKey: Bool?
        let userVerification: String?
    }

    var challengeData: Data? { Base64URL.decode(challenge) }

    /// The user handle the authenticator will bind. `nil` when the server sent
    /// something that is not base64url — fail rather than register against a
    /// handle nobody issued.
    var userIDData: Data? { Base64URL.decode(user.id) }

    var rpID: String? { rp.id }

    /// Credential IDs already enrolled, decoded. A malformed entry is dropped
    /// rather than failing the whole ceremony: the list is a filter.
    var excludedCredentialData: [Data] {
        (excludeCredentials ?? []).compactMap { Base64URL.decode($0.id) }
    }
}

// MARK: - What the client sends back

/// The body of `POST /api/auth/passkey/verify-registration`, which the server
/// reads as `{ "response": <this>, "name": ... }`. Field names are
/// SimpleWebAuthn's, including `rawId` and base64url `id`.
struct PasskeyAttestation: Encodable, Sendable {
    let id: String
    let rawID: String
    let type: String
    let authenticatorAttachment: String?
    let clientExtensionResults: [String: String]
    let response: AttestationResponse

    struct AttestationResponse: Encodable, Sendable {
        let clientDataJSON: String
        let attestationObject: String
    }

    enum CodingKeys: String, CodingKey {
        case id
        case rawID = "rawId"
        case type
        case authenticatorAttachment
        case clientExtensionResults
        case response
    }

    init(
        credentialID: Data,
        clientDataJSON: Data,
        attestationObject: Data
    ) {
        let encoded = Base64URL.encode(credentialID)
        self.id = encoded
        self.rawID = encoded
        self.type = "public-key"
        self.authenticatorAttachment = "platform"
        self.clientExtensionResults = [:]
        self.response = AttestationResponse(
            clientDataJSON: Base64URL.encode(clientDataJSON),
            attestationObject: Base64URL.encode(attestationObject)
        )
    }
}

struct VerifyRegistrationBody: Encodable, Sendable {
    let response: PasskeyAttestation
    let name: String
}

/// The bytes a registration ceremony produces, before any encoding.
struct RawRegistration: Sendable {
    let credentialID: Data
    let clientDataJSON: Data
    let attestationObject: Data
}

/// The system passkey *registration* sheet, behind a protocol.
///
/// Isolated from `PasskeyAsserting` so assertion tests do not grow a
/// registration double, and so `PasskeyController` stays assertion-only.
@MainActor
protocol PasskeyRegistering {
    func register(
        relyingPartyID: String,
        challenge: Data,
        userName: String,
        userID: Data,
        excludeCredentials: [Data]
    ) async throws -> RawRegistration
}
