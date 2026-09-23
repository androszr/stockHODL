import Foundation
import Observation

/// Session state for the whole app, and the only place that decides what the
/// user is told when signing in fails.
///
/// `@Observable` rather than `ObservableObject` for the reason set out in plan
/// A.7: SwiftUI invalidates per property read, so a view that only looks at
/// `state` does not re-render because something else on this object changed.
@MainActor
@Observable
final class AuthStore {
    enum State: Equatable {
        /// Before the stored token has been checked. The UI shows nothing
        /// decisive here — flashing a sign-in screen at someone who is already
        /// signed in is worse than a moment of blank.
        case checking
        case signedOut
        case signingIn
        case signedIn(SessionUser)

        static func == (lhs: State, rhs: State) -> Bool {
            switch (lhs, rhs) {
            case (.checking, .checking), (.signedOut, .signedOut), (.signingIn, .signingIn):
                true
            case let (.signedIn(a), .signedIn(b)):
                a.id == b.id
            default:
                false
            }
        }
    }

    /// The same stance the web login form takes: never distinguish "no such
    /// credential" from "wrong credential". There is one user and one way in,
    /// so a specific message buys nothing and a vague one gives an enumeration
    /// attempt nothing either.
    static let genericError = "Could not sign in. Try again."

    private(set) var state: State = .checking
    private(set) var errorMessage: String?

    private let auth: AuthClient
    private let tokens: TokenStore
    private let passkeys: any PasskeyAsserting
    private let relyingPartyID: String
    /// The last identity the server confirmed. In memory by default so a test
    /// never inherits another test's user; the real one is wired in
    /// `AuthStore+Live`.
    private let users: any SessionUserCaching

    init(
        auth: AuthClient,
        tokens: TokenStore,
        passkeys: any PasskeyAsserting,
        relyingPartyID: String,
        users: any SessionUserCaching = InMemorySessionUserCache()
    ) {
        self.auth = auth
        self.tokens = tokens
        self.passkeys = passkeys
        self.relyingPartyID = relyingPartyID
        self.users = users
    }

    /// The token, for callers that need to make authenticated requests. C2's
    /// data layer reads this rather than touching the Keychain itself.
    var sessionToken: String? { try? tokens.read() }

    // MARK: - Lifecycle

    /// Called once at launch. A stored token is not trusted on its own: the
    /// session may have expired (seven days sliding) or been revoked from the
    /// web, and both look identical from inside the Keychain.
    ///
    /// A network failure is deliberately NOT treated as signed-out. Purging a
    /// valid token because the train went into a tunnel would cost a Face ID
    /// and, worse, teach the user that the app logs itself out at random.
    func restore() async {
        guard let token = try? tokens.read(), !token.isEmpty else {
            #if DEBUG
                print("[auth] restore: no token in keychain — signing out")
            #endif
            users.clear()
            state = .signedOut
            return
        }
        #if DEBUG
            print("[auth] restore: found a token, asking the server")
        #endif

        do {
            if let user = try await auth.currentUser(token: token) {
                users.write(user)
                state = .signedIn(user)
            } else {
                // The server SAID no. That is the one answer that clears
                // everything, because it is the only one that proves anything.
                try? tokens.clear()
                users.clear()
                state = .signedOut
            }
        } catch {
            // Unreachable server, not a rejected token — so the token stays,
            // and so does the screen.
            //
            // This used to fall to sign-in, on the grounds that nothing here
            // can PROVE the session is good. True, and beside the point: the
            // token is still in the Keychain, the last payload is still in the
            // App Group container, and the honest rendering of "I could not
            // ask" is the portfolio with `Data from HH:MM` over it — which is
            // exactly what `LiveStore` already draws. Showing a sign-in screen
            // instead threw all of that away over a tunnel, and off the
            // debugger a relaunch in a tunnel is an ordinary morning.
            //
            // A 4xx other than the 401 handled above is NOT this case: the
            // server answered, and answering badly is a reason to stop
            // guessing.
            if AuthStore.isUnreachable(error), let remembered = users.read() {
                #if DEBUG
                    print("[auth] restore could not reach the server — staying on \(remembered.id): \(error)")
                #endif
                state = .signedIn(remembered)
            } else {
                state = .signedOut
            }
        }
    }

    /// Did the request fail to get an ANSWER? Transport failures obviously,
    /// and 5xx too: a cold function that fell over says nothing about whether
    /// this session is valid, and treating it as a rejection would sign the
    /// user out every time the platform hiccupped.
    private static func isUnreachable(_ error: Error) -> Bool {
        switch error {
        case APIError.transport:
            true
        case let APIError.http(status, _):
            status >= 500
        default:
            false
        }
    }

    // MARK: - Sign in

    func signIn() async {
        guard state != .signingIn else { return }
        state = .signingIn
        errorMessage = nil

        do {
            let (options, cookies) = try await auth.authenticationOptions()

            guard let challenge = options.challengeData else {
                throw APIError.decoding(DecodingError.dataCorrupted(.init(
                    codingPath: [],
                    debugDescription: "challenge is not base64url"
                )))
            }

            let raw = try await passkeys.assert(
                // The server's rpId when it sends one, the API host otherwise.
                // They are the same value today; preferring the server's means
                // a future change on that side does not need a new build.
                relyingPartyID: options.rpID ?? relyingPartyID,
                challenge: challenge,
                allowedCredentials: options.allowedCredentialData
            )

            let assertion = PasskeyAssertion(
                credentialID: raw.credentialID,
                clientDataJSON: raw.clientDataJSON,
                authenticatorData: raw.authenticatorData,
                signature: raw.signature,
                userHandle: raw.userHandle
            )

            let (token, user) = try await auth.verify(assertion: assertion, cookies: cookies)

            // Store BEFORE announcing success. A view that reacts to
            // `.signedIn` by firing a request would otherwise race the write
            // and find no token.
            try tokens.write(token)
            users.write(user)
            state = .signedIn(user)
        } catch PasskeyError.cancelled {
            // Not a failure. The user closed the sheet.
            state = .signedOut
        } catch {
            // The user gets one deliberately vague sentence; the developer
            // should not have to. Without this the first on-device failure is
            // indistinguishable from the fiftieth, and a plain unreachable
            // host reads exactly like a rejected credential.
            #if DEBUG
                print("[auth] sign-in failed: \(error)")
            #endif
            errorMessage = AuthStore.genericError
            state = .signedOut
        }
    }

    /// Emergency password. Every failure — disabled password path, allowlist
    /// refusal, missing `set-auth-token` — collapses to `genericError`. The
    /// user typed the email; a wrong one must not surface "Registration is
    /// closed."
    func signInWithPassword(email: String, password: String) async {
        guard state != .signingIn else { return }
        state = .signingIn
        errorMessage = nil

        do {
            let (token, user) = try await auth.signInWithEmail(email: email, password: password)

            // Store BEFORE announcing success. Same race as the passkey path.
            try tokens.write(token)
            users.write(user)
            state = .signedIn(user)
        } catch {
            #if DEBUG
                print("[auth] password sign-in failed: \(error)")
            #endif
            errorMessage = AuthStore.genericError
            state = .signedOut
        }
    }

    // MARK: - Sign out

    /// Revoke server side, then purge locally — and purge even when the revoke
    /// fails.
    ///
    /// The order matters and so does the unconditional purge: a user who taps
    /// sign out on a flaky connection must not be left holding a live token
    /// because the request timed out. The server-side session then expires on
    /// its own schedule, which is the lesser of the two problems by a wide
    /// margin.
    func signOut() async {
        let token = try? tokens.read()
        if let token, !token.isEmpty {
            try? await auth.signOut(token: token)
        }
        try? tokens.clear()
        users.clear()
        errorMessage = nil
        state = .signedOut
    }
}
