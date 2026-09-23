import AuthenticationServices
import UIKit

/// The real passkey *registration* ceremony.
///
/// New file so `PasskeyController` stays assertion-only. Same constraints:
/// system UI, Associated Domains, not reachable from a unit test. Everything
/// it produces is plain `Data`.
@MainActor
final class PasskeyRegistrationController: NSObject, PasskeyRegistering {
    private var continuation: CheckedContinuation<RawRegistration, Error>?
    /// The controller must outlive `performRequests()`; a local would be
    /// released the moment `register` suspends and the sheet would never appear.
    private var controller: ASAuthorizationController?

    func register(
        relyingPartyID: String,
        challenge: Data,
        userName: String,
        userID: Data,
        excludeCredentials: [Data]
    ) async throws -> RawRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: relyingPartyID
        )
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: userName,
            userID: userID
        )

        if !excludeCredentials.isEmpty {
            if #available(iOS 17.4, *) {
                request.excludedCredentials = excludeCredentials.map {
                    ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
                }
            }
        }

        // Matches the server: the plugin generates options with `preferred`
        // and verifies with `requireUserVerification: false`.
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

    private func finish(_ result: Result<RawRegistration, Error>) {
        controller = nil
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}

extension PasskeyRegistrationController: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard
            let credential = authorization.credential
                as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
            let attestationObject = credential.rawAttestationObject
        else {
            finish(.failure(PasskeyError.unexpectedCredential))
            return
        }

        finish(.success(RawRegistration(
            credentialID: credential.credentialID,
            clientDataJSON: credential.rawClientDataJSON,
            attestationObject: attestationObject
        )))
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        if let authError = error as? ASAuthorizationError,
           authError.code == .canceled || authError.code == .notInteractive {
            finish(.failure(PasskeyError.cancelled))
            return
        }
        finish(.failure(PasskeyError.failed(error)))
    }
}

extension PasskeyRegistrationController: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
            ?? ASPresentationAnchor()
    }
}
