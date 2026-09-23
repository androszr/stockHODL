import Foundation

/// The two JSON shapes the passkey ceremony exchanges with Better Auth.
///
/// These are hand-written rather than generated, and that is a considered
/// exception to the rule in `Generated/Contracts.swift`: they are not our
/// contract. They belong to the WebAuthn Level 2 JSON serialization, which
/// `@better-auth/passkey` implements through SimpleWebAuthn — a standard that
/// changes on a different schedule from `src/lib/api/contracts/` and is not
/// described by any zod schema in this repo. Generating them would imply a
/// source of truth that does not exist.
///
/// Every binary field is base64url. See `Base64URL` for why that matters more
/// here than it looks.

// MARK: - What the server sends

/// `GET /api/auth/passkey/generate-authenticate-options`.
///
/// Only the fields this client acts on are decoded. `extensions` and
/// `userVerification` are read but unused today; they are kept so that a server
/// that starts sending something meaningful shows up in a diff rather than
/// being silently dropped.
struct PasskeyRequestOptions: Decodable, Sendable {
    let challenge: String
    let rpID: String?
    let timeout: Int?
    let userVerification: String?
    let allowCredentials: [AllowedCredential]?

    struct AllowedCredential: Decodable, Sendable {
        let id: String
        let type: String?
        let transports: [String]?
    }

    enum CodingKeys: String, CodingKey {
        case challenge
        // The wire spells it `rpId`. Spelled `rpID` here to match Swift's own
        // capitalisation of the acronym at the one place it is read.
        case rpID = "rpId"
        case timeout
        case userVerification
        case allowCredentials
    }

    /// The raw challenge bytes to sign. `nil` when the server sent something
    /// that is not base64url — worth failing on rather than asking for Face ID
    /// against a challenge nobody issued.
    var challengeData: Data? { Base64URL.decode(challenge) }

    /// Credential IDs the server will accept, decoded. A malformed entry is
    /// dropped rather than failing the whole ceremony: the list is a filter, so
    /// one bad entry should not stop a working passkey from being offered.
    var allowedCredentialData: [Data] {
        (allowCredentials ?? []).compactMap { Base64URL.decode($0.id) }
    }
}

// MARK: - What the client sends back

/// The body of `POST /api/auth/passkey/verify-authentication`, which the server
/// reads as `{ "response": <this> }`.
///
/// The field names are not ours to choose — SimpleWebAuthn matches them exactly
/// — so they are spelled here once and asserted in a test. In particular the
/// server looks the stored passkey up by string equality on `id`, so an `id`
/// encoded as standard base64 rather than base64url fails as "passkey not
/// found": a message that points at the wrong problem entirely.
struct PasskeyAssertion: Encodable, Sendable {
    let id: String
    let rawID: String
    let type: String
    let authenticatorAttachment: String?
    let clientExtensionResults: [String: String]
    let response: AssertionResponse

    struct AssertionResponse: Encodable, Sendable {
        let clientDataJSON: String
        let authenticatorData: String
        let signature: String
        let userHandle: String?
    }

    enum CodingKeys: String, CodingKey {
        case id
        case rawID = "rawId"
        case type
        case authenticatorAttachment
        case clientExtensionResults
        case response
    }

    /// Build from the raw `Data` that `AuthenticationServices` produces.
    ///
    /// `id` and `rawId` are the same bytes twice over. That is the standard's
    /// own redundancy — `rawId` is the `ArrayBuffer` in a browser and `id` its
    /// base64url string — and in JSON they are simply equal. Sending only one
    /// of them fails validation.
    init(
        credentialID: Data,
        clientDataJSON: Data,
        authenticatorData: Data,
        signature: Data,
        userHandle: Data?
    ) {
        let encoded = Base64URL.encode(credentialID)
        self.id = encoded
        self.rawID = encoded
        self.type = "public-key"
        self.authenticatorAttachment = "platform"
        self.clientExtensionResults = [:]
        self.response = AssertionResponse(
            clientDataJSON: Base64URL.encode(clientDataJSON),
            authenticatorData: Base64URL.encode(authenticatorData),
            signature: Base64URL.encode(signature),
            userHandle: userHandle.map(Base64URL.encode)
        )
    }
}

/// The envelope. Better Auth's endpoint takes `{ response: ... }`, not the
/// assertion at the top level.
struct VerifyAuthenticationBody: Encodable, Sendable {
    let response: PasskeyAssertion
}
