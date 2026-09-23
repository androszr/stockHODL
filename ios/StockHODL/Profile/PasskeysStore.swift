import Foundation
import Observation

/// The keys that can open this account, and how many of them there are.
///
/// A tiny store for a screen that is opened rarely, so it is deliberately
/// dumber than the live ones: no poll, no stream, no snapshot. It loads when
/// the profile sheet appears and again after a removal, and that is the whole
/// lifecycle.
///
/// It exists at all — rather than a `.task` on the view — because removal has
/// a REFUSAL worth rendering, and a view that both fetches and interprets
/// server refusals is a view nothing can test.
@Observable
@MainActor
final class PasskeysStore {
    private(set) var items: [PasskeyItem] = []
    /// The SERVER's verdict on whether any key may go, not `items.count > 1`.
    /// The rule lives in `src/lib/passkeys/manage.ts`; re-deriving it here
    /// would be a second copy of a rule whose failure mode is losing the
    /// account.
    private(set) var canRemove = false

    private(set) var isLoading = false
    private(set) var errorMessage: String?

    static let genericError = "Could not load your passkeys."
    static let removeError = "Could not remove that passkey."
    static let addError = "Could not add that passkey."
    /// Better Auth `SESSION_NOT_FRESH` on generate-register-options. Password
    /// failures stay the generic sign-in sentence; this is the one place a
    /// stale session is worth naming.
    static let staleSessionError = "Sign in again to add a passkey."

    private let client: PasskeysClient
    private let registrar: any PasskeyRegistering
    private let relyingPartyID: String
    private let tokenProvider: @MainActor () -> String?

    init(
        client: PasskeysClient,
        registrar: any PasskeyRegistering,
        relyingPartyID: String,
        tokenProvider: @escaping @MainActor () -> String?
    ) {
        self.client = client
        self.registrar = registrar
        self.relyingPartyID = relyingPartyID
        self.tokenProvider = tokenProvider
    }

    func load() async {
        guard let token = tokenProvider() else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            let response = try await client.list(token: token)
            items = response.items
            canRemove = response.canRemove
            errorMessage = nil
        } catch {
            #if DEBUG
                print("[passkeys] load failed: \(error)")
            #endif
            // A list already on screen stays on screen: it was true a moment
            // ago, and blanking it to say "could not load" loses more than it
            // tells.
            if items.isEmpty { errorMessage = PasskeysStore.genericError }
        }
    }

    /// Remove one, then RELOAD rather than dropping the row locally.
    ///
    /// `canRemove` flips on the second-to-last removal, and a local drop would
    /// leave the screen offering a delete the server is now certain to refuse.
    func remove(_ item: PasskeyItem) async {
        guard let token = tokenProvider() else { return }
        errorMessage = nil

        do {
            try await client.remove(id: item.id, token: token)
        } catch let APIError.http(_, message) {
            // The server's own sentence when it wrote one — "this is your
            // only passkey" is the answer, and a generic failure in its place
            // would send someone looking for a bug that is not there.
            errorMessage = message ?? PasskeysStore.removeError
            return
        } catch {
            #if DEBUG
                print("[passkeys] remove failed: \(error)")
            #endif
            errorMessage = PasskeysStore.removeError
            return
        }

        await load()
    }

    /// Enroll a new key, then RELOAD rather than appending locally — `canRemove`
    /// flips on the second key, and a local append would leave the screen
    /// offering a delete the server has not yet confirmed.
    func add(name: String) async {
        guard let token = tokenProvider() else { return }
        errorMessage = nil

        do {
            let (options, cookies) = try await client.registrationOptions(token: token, name: name)

            guard let challenge = options.challengeData, let userID = options.userIDData else {
                throw APIError.decoding(DecodingError.dataCorrupted(.init(
                    codingPath: [],
                    debugDescription: "registration challenge or user id is not base64url"
                )))
            }

            let raw = try await registrar.register(
                relyingPartyID: options.rpID ?? relyingPartyID,
                challenge: challenge,
                userName: options.user.name,
                userID: userID,
                excludeCredentials: options.excludedCredentialData
            )

            let attestation = PasskeyAttestation(
                credentialID: raw.credentialID,
                clientDataJSON: raw.clientDataJSON,
                attestationObject: raw.attestationObject
            )
            try await client.verifyRegistration(
                attestation: attestation,
                name: name,
                cookies: cookies,
                token: token
            )
        } catch PasskeyError.cancelled {
            return
        } catch let APIError.http(_, message) {
            errorMessage = Self.addFailureMessage(message)
            return
        } catch {
            #if DEBUG
                print("[passkeys] add failed: \(error)")
            #endif
            errorMessage = PasskeysStore.addError
            return
        }

        await load()
    }

    func dismissError() {
        errorMessage = nil
    }

    func purge() {
        items = []
        canRemove = false
        errorMessage = nil
    }

    /// Better Auth's own sentence is "Session is not fresh" — jargon that
    /// reads as a bug. Map it (and the code, if the message field is absent)
    /// onto a next-step. Any other refusal keeps the server sentence.
    static func addFailureMessage(_ message: String?) -> String {
        switch message {
        case "Session is not fresh", "SESSION_NOT_FRESH":
            return staleSessionError
        default:
            return message ?? addError
        }
    }
}

extension PasskeyItem {
    /// What the row calls this key. Named at registration; a key enrolled
    /// before that existed has to say something.
    var displayName: String {
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Unnamed passkey" : trimmed
    }

    /// The web's sentence, verbatim: whether losing this phone loses this key.
    /// `deviceType` is the plugin's vocabulary and never shown raw.
    var syncDescription: String {
        deviceType == "multiDevice" ? "Synced" : "This device only"
    }

    /// "Synced · backed up · added 04.03.2026" — the pieces that exist,
    /// joined. Built here rather than in the view so a test can read it.
    var subtitle: String {
        var parts = [syncDescription]
        if backedUp { parts.append("backed up") }
        if let added = addedDescription { parts.append("added \(added)") }
        return parts.joined(separator: " · ")
    }

    private var addedDescription: String? {
        guard let createdAtISO, let date = PasskeyItem.parseInstant(createdAtISO) else {
            return nil
        }
        return date.formatted(.dateTime.day().month().year())
    }

    /// The column is a `timestamptz` serialised by `toISOString()`, so it
    /// always carries fractional seconds — a parser that rejects those would
    /// silently drop the date from EVERY row rather than fail anywhere
    /// visible. The plain form is tried second so a hand-written or migrated
    /// row does not lose its date either.
    ///
    /// `ISO8601FormatStyle` rather than a shared `ISO8601DateFormatter`: the
    /// formatter is a class with mutable options and is not `Sendable`, so a
    /// static one is a data race waiting for a second caller.
    static func parseInstant(_ iso: String) -> Date? {
        let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let date = try? withFraction.parse(iso) { return date }
        return try? Date.ISO8601FormatStyle().parse(iso)
    }
}
