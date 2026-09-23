import Foundation

/// What a screen is allowed to CLAIM about the figures it is drawing.
///
/// Three cases rather than a `Bool`, because the app can be in three genuinely
/// different positions and the old `isOffline` flag collapsed the last two:
///
///   - `fresh` — the network answered, and these are its figures. Say nothing;
///   - `stale` — these figures were true when they were taken and have not
///     been confirmed since. The network may be fine and the server may be
///     down; we do not know, and the honest label says only how old the money
///     is;
///   - `disconnected` — the same, except we DO know why: the OS says there is
///     no route off the device. Worth a different sentence, because it is the
///     one case the user can act on.
///
/// `since` is the device clock at the moment the payload was received, not the
/// server's `serverNowMs` — that answers how fresh the QUOTES are, and this
/// bar answers when the phone last had a working connection. It is optional
/// because a screen can be disconnected with nothing yet drawn at all.
enum Freshness: Equatable, Sendable {
    case fresh
    case stale(since: Date?)
    case disconnected(since: Date?)

    /// Whether the screen owes the user a disclosure. Kept as a computed
    /// property rather than left to each view's `switch`, so the two bars
    /// cannot drift apart on what counts as stale.
    var needsDisclosure: Bool { self != .fresh }

    /// When the figures were taken, whichever non-fresh case we are in.
    var since: Date? {
        switch self {
        case .fresh: nil
        case let .stale(since), let .disconnected(since): since
        }
    }
}

/// The freshness bookkeeping every data store was doing for itself.
///
/// `LiveStore`, `WatchlistStore` and `OptionsStore` each carried their own
/// `consecutiveFailures` counter, their own `>= 2` threshold and their own
/// `isOffline` flag, written out three times and — inevitably — reset in
/// slightly different places. This is that logic once, as a value type, so
/// there is one answer to "may this screen claim the data is current".
///
/// A value type rather than a class: a store owns one, mutates it in place,
/// and `@Observable` picks the change up through the store's own property.
/// Nothing here is shared, so nothing here needs identity.
struct StaleState: Equatable, Sendable {
    /// When the displayed figures were received. Survives a failure — that is
    /// the whole point of it — and is only replaced by a success.
    private(set) var capturedAt: Date?
    /// Has the network confirmed anything at all since this store woke up?
    ///
    /// The flag that fixes the cold-launch lie. A snapshot painted from disk
    /// used to look identical to a fresh fetch until TWO requests had failed,
    /// so a launch with no signal showed yesterday's money, undisclosed, for
    /// as long as two timeouts take. Painting from disk sets `capturedAt`
    /// without setting this, and unconfirmed-with-something-on-screen is
    /// exactly the definition of stale.
    private(set) var isConfirmed = false
    private(set) var consecutiveFailures = 0
    /// The OS's opinion of the radio, pushed in by whoever owns this state.
    /// Defaults to connected for the same reason `Reachability` does: an
    /// optimistic start costs nothing, a pessimistic one flashes a banner over
    /// a screen that was about to load.
    private(set) var isConnected = true

    /// Two failures, not one, and the threshold stays where it was.
    ///
    /// One failed request on a moving train is noise, and a bar that claims
    /// the data is old had better be right. This only ever applies when the
    /// radio looks HEALTHY — a known-disconnected device needs no second
    /// opinion, and making it wait for one was the slow half of the old
    /// behaviour.
    static let failureThreshold = 2

    init() {}

    // MARK: - Transitions

    /// Painted from disk. Gives the screen an age to show without letting it
    /// claim the figures are current.
    mutating func restored(from capturedAt: Date?) {
        guard !isConfirmed else { return }
        self.capturedAt = capturedAt
    }

    /// The network answered, and the answer was data.
    mutating func succeeded(at now: Date) {
        capturedAt = now
        isConfirmed = true
        consecutiveFailures = 0
    }

    /// A request did not produce data. Every failure path goes through here —
    /// a transport error, a 500, a decode, and (deliberately) a missing token,
    /// which is a failure to ask rather than a different kind of answer.
    mutating func failed() {
        // Saturating rather than unbounded: the counter's only job is to
        // compare against a threshold and to pick a backoff step, both of
        // which stop mattering long before a phone left offline overnight
        // could overflow anything.
        consecutiveFailures = min(consecutiveFailures + 1, 32)
    }

    /// The radio changed. Does not touch the failure count: a route appearing
    /// is not evidence that the last request would have succeeded, and
    /// zeroing here would let a captive portal reset the backoff forever.
    mutating func connectivityChanged(to connected: Bool) {
        isConnected = connected
    }

    // MARK: - Verdicts

    var freshness: Freshness {
        // A confirmed payload with nothing failing since is the ordinary case
        // and the only one that gets to say nothing.
        if isConfirmed, consecutiveFailures == 0 { return .fresh }

        // Known-disconnected outranks counting. This is the case the counter
        // could never reach quickly, and the only one that can name a cause.
        if !isConnected { return .disconnected(since: capturedAt) }

        if consecutiveFailures >= StaleState.failureThreshold {
            return .stale(since: capturedAt)
        }

        // Something is on screen that the network has not confirmed — a disk
        // snapshot on a cold launch. Stale from the first frame, which is the
        // point of `isConfirmed` existing.
        if !isConfirmed, capturedAt != nil { return .stale(since: capturedAt) }

        // One transient failure over a healthy-looking network, with confirmed
        // data behind it. Noise; say nothing until it happens again.
        return .fresh
    }

    /// The old flag, kept as a name the views already understand.
    var isOffline: Bool { freshness.needsDisclosure }

    /// Should a store even TRY a request right now?
    ///
    /// False only when the OS says there is no route AND we have already
    /// proved it by failing at least once. The second half matters: the first
    /// request after launch goes out regardless of what the monitor thinks,
    /// because a path that is `.unsatisfied` for the half-second before the
    /// first update lands must not silently skip the load the user is waiting
    /// for.
    var shouldAttempt: Bool {
        isConnected || consecutiveFailures == 0
    }

    /// Clear everything derived from a session. Used by sign-out and by the
    /// stores' own `purge()`.
    mutating func reset() {
        self = StaleState()
    }
}
