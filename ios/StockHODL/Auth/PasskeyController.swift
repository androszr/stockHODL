import AuthenticationServices
import UIKit

/// The real passkey ceremony.
///
/// This is the only file in the sign-in path that a unit test cannot exercise —
/// it presents system UI and needs Associated Domains to have been verified for
/// `sawa-finance.vercel.app`. Everything it produces is plain `Data`, which is
/// what makes the rest of the flow testable.
///
/// No enrollment here, only assertion (plan A.8): the passkey being used is the
/// same one registered on the web, shared through iCloud Keychain because the
/// relying party ID is the same host. Registering NEW keys stays on the web.
@MainActor
final class PasskeyController: NSObject, PasskeyAsserting {
    private var continuation: CheckedContinuation<RawAssertion, Error>?
    /// The controller must outlive `performRequests()`; a local would be
    /// released the moment `assert` suspends and the sheet would never appear.
    private var controller: ASAuthorizationController?

    func assert(
        relyingPartyID: String,
        challenge: Data,
        allowedCredentials: [Data]
    ) async throws -> RawAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: relyingPartyID
        )
        let request = provider.createCredentialAssertionRequest(challenge: challenge)

        // An empty list means "any credential for this relying party", which is
        // what the server sends when it cannot tell who is asking. Assigning an
        // empty array instead would mean "no credential is acceptable" and the
        // sheet would offer nothing.
        if !allowedCredentials.isEmpty {
            request.allowedCredentials = allowedCredentials.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }

        // Matches the server: the plugin generates options with `preferred` and
        // verifies with `requireUserVerification: false`. Demanding `required`
        // here would be a promise the verifier does not check.
        request.userVerificationPreference = .preferred

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<RawAssertion, Error>) {
        controller = nil
        // A continuation resumed twice is a crash, and a delegate that fires
        // both callbacks is not something this code controls. Taking it first
        // makes the second call a no-op.
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}

extension PasskeyController: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard
            let assertion = authorization.credential
                as? ASAuthorizationPlatformPublicKeyCredentialAssertion
        else {
            finish(.failure(PasskeyError.unexpectedCredential))
            return
        }

        finish(.success(RawAssertion(
            credentialID: assertion.credentialID,
            clientDataJSON: assertion.rawClientDataJSON,
            authenticatorData: assertion.rawAuthenticatorData,
            signature: assertion.signature,
            userHandle: assertion.userID
        )))
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        // A dismissed sheet arrives here as an error. Treating it as one would
        // put a red banner on the screen for a user who simply changed their
        // mind. `.notInteractive` is the same story from a different angle:
        // there was no chance to interact, so there is nothing to report.
        if let authError = error as? ASAuthorizationError,
           authError.code == .canceled || authError.code == .notInteractive {
            finish(.failure(PasskeyError.cancelled))
            return
        }
        finish(.failure(PasskeyError.failed(error)))
    }
}

extension PasskeyController: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
            ?? ASPresentationAnchor()
    }
}
