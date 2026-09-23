import Foundation

/// What the app repaints from before the network has said anything.
///
/// A cold Vercel function can take a second or two (plan A.7), and a phone is
/// opened for four seconds at a time. Showing a spinner for the whole of that
/// makes the app feel broken when it is merely honest. So the last payload is
/// written to disk and the next launch paints it immediately, with the time it
/// was taken, and replaces it when the network answers.
///
/// It lives in the **App Group** container rather than the app's own sandbox,
/// and that is the whole reason the entitlement was claimed back in C1. A
/// widget cannot read the app's Documents directory; it can read this. Writing
/// here from day one means the widget in some later version is a new reader of
/// an existing file rather than a refactor of where state lives (plan A.8).
struct Snapshot: Codable, Sendable {
    /// Everything the Holdings screen needs to paint, exactly as the server
    /// composed it. Stored whole rather than picked apart: a partially
    /// reconstructed view is a second implementation of the composition, and
    /// the point of `/bootstrap` is that there is only one.
    let bootstrap: BootstrapResponse
    /// When the payload was received, by the phone's clock. The server's own
    /// `serverNowMs` answers a different question — how fresh the QUOTES are —
    /// and the bar wants to say when the user last had a working connection.
    let capturedAt: Date
}

protocol SnapshotStoring: Sendable {
    func read() -> Snapshot?
    func write(_ snapshot: Snapshot)
    func clear()
}

/// The App Group container, or nothing at all.
///
/// Failure here is deliberately silent and non-fatal: a missing snapshot costs
/// one spinner, and refusing to launch because a cache could not be written
/// would turn a cosmetic feature into an outage. The `#if DEBUG` line exists so
/// a misconfigured entitlement — the realistic cause — is visible during
/// development instead of being discovered as "the cache never works".
struct AppGroupSnapshotStore: SnapshotStoring {
    /// Must match `com.apple.security.application-groups` in
    /// `ios/Config/StockHODL.entitlements`.
    static let suiteName = "group.com.robertandrosz.stockhodl"

    private let fileURL: URL?

    init(suiteName: String = AppGroupSnapshotStore.suiteName, fileName: String = "holdings.json") {
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName)
        #if DEBUG
            if container == nil {
                print("[snapshot] no container for \(suiteName) — check the App Group entitlement")
            }
        #endif
        fileURL = container?.appending(path: fileName)
    }

    func read() -> Snapshot? {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder.snapshot.decode(Snapshot.self, from: data)
    }

    func write(_ snapshot: Snapshot) {
        guard let fileURL, let data = try? JSONEncoder.snapshot.encode(snapshot) else { return }
        // `.completeUntilFirstUserAuthentication` for the same reason the
        // Keychain item uses `kSecAttrAccessibleAfterFirstUnlock`: a widget
        // refreshing on a locked phone must still be able to read it.
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}

extension JSONDecoder {
    /// Dates as epoch seconds rather than the default `.deferredToDate`, whose
    /// format is an implementation detail — and this file has to be readable by
    /// a future widget built against a different SDK.
    static var snapshot: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }
}

extension JSONEncoder {
    static var snapshot: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }
}
