import Foundation

/// The quote-poll gating policy, ported from `src/lib/holdings/poll-policy.ts`.
///
/// The distinction this carries — and that one derived boolean cannot — is
/// STRUCTURAL versus TRANSIENT emptiness:
///
///   - structural: the portfolio holds nothing the vendor can price. Polling
///     every ten seconds would fetch the same nulls forever;
///   - transient: the vendor hiccupped and one payload came back with every
///     price null. The cadence must keep running so the view self-heals.
///
/// Deciding "anything pollable?" from whether prices arrived conflates the two
/// and kills the cadence permanently on a single blip. The server already made
/// the structural call from the symbol set it actually sent to the vendor;
/// `hasPollableSymbols` on the payload IS that verdict, and this client
/// consumes it rather than second-guessing it from prices it can see.
///
/// The web equivalent of `hasPollableSymbols(outcomes)` has no counterpart here
/// on purpose: it runs over per-symbol vendor verdicts, which never leave the
/// server.
enum PollPolicy {
    /// Statuses during which the cadence runs — regular hours plus both
    /// extended sessions.
    static func isActiveStatus(_ status: MarketStatus) -> Bool {
        switch status {
        case .marketStatusOpen, .earlyTrading, .lateTrading:
            true
        case .closed, .unknown:
            false
        }
    }

    /// Poll while a session is running AND the portfolio structurally has
    /// something to poll for. Deliberately blind to whether the latest payload
    /// carried prices.
    static func shouldPollQuotes(status: MarketStatus, hasPollableSymbols: Bool) -> Bool {
        isActiveStatus(status) && hasPollableSymbols
    }

    /// Convenience over a whole payload, which is how every call site actually
    /// has the two facts to hand.
    static func shouldPoll(_ payload: LivePayload) -> Bool {
        shouldPollQuotes(
            status: payload.market.status,
            hasPollableSymbols: payload.hasPollableSymbols
        )
    }

    /// The cadence itself. Ten seconds matches the web client; the vendor feed
    /// is delayed anyway, so a tighter interval buys nothing but battery.
    static let interval: Duration = .seconds(10)
}
