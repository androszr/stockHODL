import Foundation

/// The bytes a passkey ceremony produces, before any encoding.
///
/// This exists so the WebAuthn JSON assembly can be tested without a device: the
/// values below are what `AuthenticationServices` hands over, and everything
/// after this point is pure data shuffling.
struct RawAssertion: Sendable {
    let credentialID: Data
    let clientDataJSON: Data
    let authenticatorData: Data
    let signature: Data
    /// The user handle the credential was registered with. Optional in the
    /// standard, and Better Auth ignores it — it finds the passkey by
    /// credential ID — but it is sent when present because a verifier is
    /// entitled to check it.
    let userHandle: Data?
}

enum PasskeyError: Error {
    /// The user dismissed the sheet or declined Face ID. Not a failure: the UI
    /// must return quietly to the signed-out screen with no error shown.
    case cancelled
    /// A credential of a type this app did not ask for. Unreachable in
    /// practice; present so the delegate has no silent branch.
    case unexpectedCredential
    case failed(Error)
}

/// The system passkey sheet, behind a protocol.
///
/// Everything on the far side of this — `ASAuthorizationController`, the
/// biometric prompt, the Associated Domains check — needs a signed app on real
/// hardware, so it is the one part of the sign-in path that unit tests cannot
/// reach. Isolating it here means the part they CAN reach is the whole rest of
/// the flow: options decoding, JSON assembly, token storage, purge on sign-out.
///
/// `@MainActor` because the underlying controller presents UI.
@MainActor
protocol PasskeyAsserting {
    func assert(
        relyingPartyID: String,
        challenge: Data,
        allowedCredentials: [Data]
    ) async throws -> RawAssertion
}
