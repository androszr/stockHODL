import Foundation

/// How long to wait before asking again after a failure.
///
/// The pumps used to have no answer to this. `LiveStore.poll()` fired every
/// `PollPolicy.interval` regardless of whether the last ten attempts had all
/// died on a 20-second timeout, which on a phone in a tunnel is a request
/// every thirty seconds, forever, each one waking the radio for the full
/// timeout. That is the classic way a "live" screen becomes a battery
/// complaint, and it is invisible on a desk where the requests succeed.
///
/// Doubling from the normal cadence to a one-minute ceiling. The ceiling is
/// low on purpose: this is a foreground screen the user is looking at, so the
/// cost of asking too often is battery, while the cost of asking too rarely is
/// a minute of wrong prices in front of someone who can see them. A minute is
/// where those meet. Nothing here backs off while the app is in the
/// background, because nothing here runs there at all — `scenePhaseChanged`
/// cancels the pump outright.
enum Backoff {
    static let ceiling: Duration = .seconds(60)

    /// The delay after `failures` consecutive failures, starting from `base`.
    ///
    /// Zero failures returns `base` unchanged, so a healthy pump keeps exactly
    /// the cadence `PollPolicy` chose and this type is invisible until
    /// something goes wrong.
    static func delay(after failures: Int, base: Duration) -> Duration {
        guard failures > 0 else { return base }

        // Shifting rather than multiplying, and capped at 6 shifts (64x)
        // before the ceiling clamps it anyway — a phone left offline for an
        // hour would otherwise walk the exponent into an overflow for no
        // benefit, since every value past the third step is the ceiling.
        let steps = min(failures, 6)
        let scaled = base * (1 << steps)
        return scaled > ceiling ? ceiling : scaled
    }

    /// How long to idle before re-checking a device the OS says has no route.
    ///
    /// Deliberately not tied to the failure count: a disconnected phone is not
    /// failing, it is waiting, and the wait ends on a `Reachability` edge
    /// rather than on a timer. This is only the belt to that braces — if the
    /// edge is ever missed, the pump still comes back to life within a minute
    /// instead of never.
    static let whileDisconnected: Duration = .seconds(30)
}
