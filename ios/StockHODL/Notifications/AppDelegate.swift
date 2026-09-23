import UIKit
import UserNotifications

/// The UIKit half of push: capturing the APNs device token and a tapped
/// notification, both of which only arrive through delegate callbacks
/// SwiftUI's `App` protocol has no equivalent for. Everything it learns is
/// forwarded to `PushCoordinator`, never held here.
/// `@preconcurrency` on the notification-center conformance: its protocol
/// methods are declared `nonisolated` in the SDK, while `UIApplicationDelegate`
/// makes this whole type main-actor — without it Swift 6 sees the two
/// conformances as crossing an isolation boundary and refuses to build.
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            PushCoordinator.shared.deviceToken = hex
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        #if DEBUG
            print("[push] remote registration failed: \(error)")
        #endif
    }

    /// Foreground presentation: a price move is exactly the kind of thing
    /// worth surfacing immediately, so the banner shows even while the app is
    /// already open rather than being silently swallowed (`UNUserNotificationCenter`'s
    /// default when no delegate opts in).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    /// A tap. The payload's custom `url` field is
    /// `src/lib/push/apns.ts`'s `PushAlert.urlScheme` — the same private
    /// scheme `.onOpenURL` handles for a cold launch via the scheme directly.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let urlString = response.notification.request.content.userInfo["url"] as? String,
           let destination = PushDeepLink.destination(fromURLString: urlString) {
            Task { @MainActor in
                PushCoordinator.shared.pendingDestination = destination
            }
        }
        completionHandler()
    }
}
