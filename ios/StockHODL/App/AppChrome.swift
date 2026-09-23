import SwiftUI
import UIKit

/// The one place UIKit's bar appearance is told about the palette.
///
/// SwiftUI's `TabView` and `NavigationStack` render UIKit bars, and a system
/// material bar under a token-painted app is the single loudest way the
/// native app stops looking like the web one. `.tint` alone colors the
/// selected item and nothing else, so the background, the separator and the
/// unselected label have to come through the appearance proxies.
///
/// Every color here is a `DesignToken` rendered through the dynamic
/// `UIColor(DesignToken)` bridge, so the bars re-resolve themselves on a
/// light/dark switch without anything observing the change. No literal —
/// non-negotiable #2 holds here as everywhere else.
enum AppChrome {
    static func apply() {
        applyTabBar()
        applyNavigationBar()
    }

    private static func applyTabBar() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Tokens.surface1)
        appearance.shadowColor = UIColor(Tokens.borderSubtle)

        for item in [
            appearance.stackedLayoutAppearance,
            appearance.inlineLayoutAppearance,
            appearance.compactInlineLayoutAppearance,
        ] {
            item.normal.iconColor = UIColor(Tokens.textMuted)
            item.normal.titleTextAttributes = [.foregroundColor: UIColor(Tokens.textMuted)]
            item.selected.iconColor = UIColor(Tokens.accent)
            item.selected.titleTextAttributes = [.foregroundColor: UIColor(Tokens.accent)]
        }

        UITabBar.appearance().standardAppearance = appearance
        // Without this the bar goes transparent the moment a scroll view
        // reaches its bottom edge — which, on a list of holdings, is most of
        // the time.
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    private static func applyNavigationBar() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Tokens.surface1)
        appearance.shadowColor = UIColor(Tokens.borderSubtle)
        appearance.titleTextAttributes = [
            .foregroundColor: UIColor(Tokens.textPrimary),
        ]
        appearance.largeTitleTextAttributes = [
            .foregroundColor: UIColor(Tokens.textPrimary),
        ]

        let nav = UINavigationBar.appearance()
        nav.standardAppearance = appearance
        nav.scrollEdgeAppearance = appearance
        nav.compactAppearance = appearance
        nav.compactScrollEdgeAppearance = appearance
        nav.tintColor = UIColor(Tokens.accent)
    }
}

extension View {
    /// Sheets keep the system nav bar (Cancel / Done / Save). Force the same
    /// opaque `surface-1` the tab bar already uses, including at the scroll
    /// edge — without this, iOS 26 glass lets the form slide under the title.
    func tokenSheetChrome() -> some View {
        self
            .toolbarBackground(Color(Tokens.surface1), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }

    /// The custom `TopBar` is the only chrome on a tab stack. The system bar
    /// under it was a second, glass row — hide it on the root and on every
    /// push. VoiceOver still reads `navigationTitle` on the destination.
    func hidesSystemNav() -> some View {
        toolbar(.hidden, for: .navigationBar)
    }
}

/// iOS 26 draws a soft glass fade at the top of every scroll view. The top
/// bar is already an opaque cap, so a soft edge under it is the "nav with
/// no background" the cap exists to prevent. No-op on earlier systems.
struct HardTopScrollEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            content
        }
    }
}
