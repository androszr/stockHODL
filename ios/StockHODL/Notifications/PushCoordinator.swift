import Foundation
import Observation

/// Bridges UIKit's `AppDelegate` callbacks into SwiftUI-observable state.
///
/// The `AppDelegate` outlives no state of its own and is instantiated before
/// `RootView`'s tree exists, while the stores that need what it learns (the
/// device token, a tapped notification's symbol) are built later, inside
/// `SignedInView`. A singleton is the seam between the two lifecycles — the
/// same role `AppConfig.current` plays for build configuration.
///
/// `@Observable`, not `ObservableObject` — the same choice every other store
/// in this app makes (see `AuthStore`'s note): a view reading only
/// `pendingSymbol` should not re-render because `deviceToken` changed.
@MainActor
@Observable
final class PushCoordinator {
    static let shared = PushCoordinator()

    /// The APNs device token, hex-encoded, once
    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
    /// fires. Set once per launch (registration is re-run every launch by
    /// `NotificationsStore`, but the token itself is normally stable).
    var deviceToken: String?
    /// Where to navigate, set when the user taps a notification — a stock's
    /// page for a price alert, the Dashboard for the daily summary.
    /// `SignedInView` clears it after navigating — this is a one-shot signal,
    /// not persistent state.
    var pendingDestination: PushDeepLink.Destination?

    private init() {}
}
