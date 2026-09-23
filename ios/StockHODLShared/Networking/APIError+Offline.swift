import Foundation

/// Telling "there is no network" apart from "the server is having a bad day".
///
/// `APIError.transport` has carried this distinction since the client was
/// written, and for a long time exactly two callers read it — `AuthStore`, to
/// avoid signing a user out over a tunnel, and `ImportStore`. Every screen
/// collapsed the whole enum into one sentence: "Could not load your X", under
/// a **Try again** button which, offline, cannot do anything except fail
/// again. The user is told the app is broken when the truth is that their
/// train went underground, and is then offered a control that proves it twice.
extension APIError {
    /// Did this request fail because THIS DEVICE could not get anywhere?
    ///
    /// The codes below all name the route rather than the destination. The
    /// judgement call is `.timedOut`: a cold Vercel function can genuinely
    /// take longer than the 20-second budget, so a timeout is not proof of
    /// anything — but on a phone it is overwhelmingly the shape a dying
    /// connection takes, and `Reachability` is the thing that says
    /// "disconnected" with authority. This flag only ever picks the WORDS on
    /// an error screen, so leaning towards the common cause costs a rare
    /// misdescription and saves the usual one.
    var isOffline: Bool {
        guard case let .transport(underlying) = self else { return false }
        guard let url = underlying as? URLError else { return false }
        return APIError.offlineCodes.contains(url.code)
    }

    private static let offlineCodes: Set<URLError.Code> = [
        .notConnectedToInternet,
        .networkConnectionLost,
        .dataNotAllowed,
        .internationalRoamingOff,
        .callIsActive,
        .cannotFindHost,
        .cannotConnectToHost,
        .dnsLookupFailed,
        .timedOut,
    ]

    /// Did the request fail to get an ANSWER at all?
    ///
    /// Wider than `isOffline`: any transport failure, plus 5xx, because a cold
    /// function that fell over has told us nothing about the question we
    /// asked. `AuthStore` uses this — and only this — to decide that a stored
    /// session survives, and the reasoning is written down there.
    var isUnreachable: Bool {
        switch self {
        case .transport:
            true
        case let .http(status, _):
            status >= 500
        case .decoding, .missingSessionToken:
            false
        }
    }
}

/// What to put on a screen that has nothing to draw.
///
/// One place, because the alternative is nine screens each inventing their own
/// wording for the same two situations, and they will not agree — the web app
/// learned this and settled on `OfflineBanner` saying "Can't reach the
/// network" rather than claiming the user is offline, since the app cannot
/// actually tell the difference between a dead radio and a dead server. The
/// phone CAN tell, now, which is why there are two sentences here instead of
/// one.
enum LoadFailure {
    /// The OS says there is no route. The user can act on this.
    static let offline = "Can't reach the network."

    /// The same distinction for a WRITE, which needs different words.
    ///
    /// A read that fails leaves the screen as it was; a write that fails
    /// leaves the user believing something did or did not happen. "Could not
    /// save that transaction" reads as a REFUSAL — the server looked at it and
    /// said no — and a user who believes they were refused edits the form or
    /// gives up. The truth, offline, is that nothing was ever asked, and the
    /// only sensible next step is to try again later. Those are different
    /// instructions, so they get different sentences.
    static func writeMessage(for error: Error?, connected: Bool, generic: String) -> String? {
        guard !connected || (error as? APIError)?.isOffline == true else { return nil }
        return "You're offline — nothing was saved."
    }

    /// Which sentence a screen should show, given what it knows.
    ///
    /// `connected` is `Reachability`'s answer and outranks the error: a
    /// request that failed to parse is still a network problem if the radio is
    /// off, because the parse would never have been reached had the radio been
    /// on.
    static func message(for error: Error?, connected: Bool, generic: String) -> String {
        if !connected { return offline }
        if let api = error as? APIError, api.isOffline { return offline }
        return generic
    }
}
