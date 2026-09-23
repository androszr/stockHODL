import Foundation
import Testing

@testable import StockHODL

/// The plists in `ios/Config` are PARTIAL — `GENERATE_INFOPLIST_FILE` merges
/// them into the one Xcode builds — so the only file that proves anything is
/// the MERGED plist inside the built app bundle. `TEST_HOST` points this
/// bundle at `StockHODL.app`, so `Bundle.main` here IS that bundle and this
/// suite reads the real thing rather than the source file.
///
/// It therefore checks the CONFIGURATION CURRENTLY BUILT — Debug, when run in
/// Xcode. `scripts/check-privacy-strings.py` covers the Release plist, the
/// two-file agreement and the widget plists, and runs on every push. The two
/// guards are complementary, not redundant: this one is the one that fails
/// fast on a developer's machine, and it is the only one that would notice a
/// key that survives in the source file but is lost in the merge.
@Suite("Privacy usage strings")
struct PrivacyStringsTests {
    /// Every in-process TCC gate the app can reach. Breaking any one of these
    /// does not cost a permission prompt — iOS kills the process the moment
    /// the gate is touched, which for the dictation keys means tapping the
    /// microphone on the keyboard in any free-text field closes the app.
    private static let required = [
        "NSCameraUsageDescription",  // screenshot import
        "NSMicrophoneUsageDescription",  // keyboard dictation
        "NSSpeechRecognitionUsageDescription",  // the same key's speech-to-text half
    ]

    @Test("the built bundle declares every gate the app can reach", arguments: required)
    func declaresUsageString(key: String) {
        let value = Bundle.main.object(forInfoDictionaryKey: key) as? String

        #expect(value != nil, "\(key) is missing from the built Info.plist")
        // A blank string is not a declaration: iOS treats it exactly as it
        // treats an absent key, so the process still dies.
        #expect(value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
    }
}
