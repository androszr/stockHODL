import SwiftUI
#if canImport(UIKit)
    import UIKit

    /// The platform's bitmap image: `UIImage` on the phone, `NSImage` on the
    /// Mac. Both decode from `Data`, both report `size` in points, so the
    /// logo cache, the news thumbnail and the screenshot import are written
    /// once against this name (plans/2026-09-28-native-mac-app-stage-1.md).
    typealias PlatformImage = UIImage
#elseif canImport(AppKit)
    import AppKit

    typealias PlatformImage = NSImage
#endif

extension Image {
    init(platformImage: PlatformImage) {
        #if canImport(UIKit)
            self.init(uiImage: platformImage)
        #elseif canImport(AppKit)
            self.init(nsImage: platformImage)
        #endif
    }
}
