import SwiftUI

@main
struct StockHODLApp: App {
    /// Captures the two UIKit-only push callbacks (the APNs device token and
    /// a tapped notification) and forwards them to `PushCoordinator`, which
    /// `SignedInView` observes. See `AppDelegate.swift`.
    /// On the Mac the same two callbacks arrive through `NSApplicationDelegate`.
    #if os(iOS)
        @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #else
        @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    init() {
        // Before the first view exists: `UITabBar.appearance()` is a proxy
        // read at bar-creation time, so setting it later would leave the
        // first tab bar system-material.
        AppChrome.apply()
    }

    var body: some Scene {
        #if os(macOS)
            // ONE window, not a `WindowGroup`: every `RootView` builds its own
            // AuthStore and a full set of stores with live pumps, so a second
            // window would be a second signed-in tree (still signed in on a
            // revoked token after the other signs out), and a closed-but-
            // running group would keep four pumps streaming with no window.
            // `Window` has no File > New Window, and as the app's only scene
            // closing it quits the app — the delegate says so explicitly too.
            Window("StockHODL", id: "main") {
                RootView()
            }
            .defaultSize(width: 1100, height: 720)
        #else
            WindowGroup {
                RootView()
            }
        #endif
    }
}
