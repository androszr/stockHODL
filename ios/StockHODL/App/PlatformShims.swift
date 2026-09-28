#if os(macOS)
    import SwiftUI

    /// No-op stand-ins for the phone-only modifiers the shared screens use, so
    /// every call site compiles unchanged on the Mac
    /// (plans/2026-09-28-native-mac-app-stage-1.md). A Mac window has no
    /// navigation-bar title mode, no software keyboard to pick a layout for
    /// and no automatic capitalisation, so returning `self` IS the behaviour.
    ///
    /// These overload SwiftUI's own declarations, which are unavailable on
    /// macOS; the argument types below are what the call sites resolve to.

    enum NavigationBarTitleDisplayModeShim {
        case automatic, inline, large
    }

    enum TextInputAutocapitalizationShim {
        case never, characters, words, sentences
    }

    /// Spelled like UIKit's so `FormField.keyboard: UIKeyboardType` and every
    /// `.decimalPad` argument compile unchanged. Only the cases in use.
    enum UIKeyboardType: Sendable {
        case `default`, decimalPad, emailAddress, numberPad, asciiCapable
    }

    extension View {
        func navigationBarTitleDisplayMode(_ mode: NavigationBarTitleDisplayModeShim) -> some View {
            self
        }

        func textInputAutocapitalization(_ mode: TextInputAutocapitalizationShim) -> some View {
            self
        }

        func keyboardType(_ type: UIKeyboardType) -> some View {
            self
        }
    }
#endif
