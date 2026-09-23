import SwiftUI

@main
struct StockHODLApp: App {
    /// Captures the two UIKit-only push callbacks (the APNs device token and
    /// a tapped notification) and forwards them to `PushCoordinator`, which
    /// `SignedInView` observes. See `AppDelegate.swift`.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // Before the first view exists: `UITabBar.appearance()` is a proxy
        // read at bar-creation time, so setting it later would leave the
        // first tab bar system-material.
        AppChrome.apply()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
