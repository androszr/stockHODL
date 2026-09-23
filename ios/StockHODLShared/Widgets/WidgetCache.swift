import Foundation

/// The last payload a widget successfully fetched, and when.
///
/// A timeline entry has to render something every time the system asks, and
/// the system asks at moments the user did not choose — on a train, in a
/// tunnel, at 06:00 before the phone has a route to anywhere. A placeholder in
/// those moments reads as a broken widget; yesterday's close, dated, reads as
/// a widget with nothing new to say. So a failed refresh falls back to this,
/// carrying its own age so the view can admit how old it is.
struct CachedWidgetPayload: Codable, Sendable {
    let payload: WidgetSummaryResponse
    /// Device clock at the moment the payload was received — the same question
    /// `Snapshot.capturedAt` answers, and deliberately not the server's
    /// `serverNowMs`, which says how fresh the QUOTES are rather than when the
    /// phone last had a working connection.
    let capturedAt: Date
}

protocol WidgetCaching: Sendable {
    func read() -> CachedWidgetPayload?
    func write(_ cached: CachedWidgetPayload)
}

/// The App Group container — the same one `AppGroupSnapshotStore` writes the
/// Holdings snapshot into, and a separate file rather than a field inside it.
///
/// Separate because the two have different writers and different lifetimes:
/// the app writes `holdings.json` when a screen loads, the widget writes this
/// when the SYSTEM woke it, which may be days apart. Sharing one file would
/// mean two processes racing to rewrite each other's half, and an app that has
/// never been opened since the update would keep clearing the widget's data
/// back out.
struct AppGroupWidgetCache: WidgetCaching {
    /// Must match `com.apple.security.application-groups` in BOTH
    /// `ios/Config/StockHODL.entitlements` and
    /// `ios/Config/StockHODLWidgets.entitlements`.
    static let suiteName = AppGroupSnapshotStore.suiteName

    private let fileURL: URL?

    init(suiteName: String = AppGroupWidgetCache.suiteName, fileName: String = "widget.json") {
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName)
        #if DEBUG
            if container == nil {
                print("[widget] no container for \(suiteName) — check the App Group entitlement")
            }
        #endif
        fileURL = container?.appending(path: fileName)
    }

    func read() -> CachedWidgetPayload? {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder.snapshot.decode(CachedWidgetPayload.self, from: data)
    }

    func write(_ cached: CachedWidgetPayload) {
        guard let fileURL, let data = try? JSONEncoder.snapshot.encode(cached) else { return }
        // `completeUntilFirstUserAuthentication`, matching the snapshot and the
        // Keychain item: a widget refreshed on a locked phone must be able to
        // write what it fetched, or the lock screen would never cache anything.
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
