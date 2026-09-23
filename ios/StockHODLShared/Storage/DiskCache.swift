import Foundation

/// A decoded payload and the moment it arrived.
///
/// The age is stored WITH the value rather than derived from the file's
/// modification date: a file can be touched by a backup restore, an iCloud
/// sync or a debugger, and a portfolio screen that says "data from 09:41"
/// because the filesystem said so would be quoting the wrong clock. The device
/// clock at the moment of receipt is the only thing that answers "when did
/// this phone last have a working connection", which is what the bar claims.
struct CachedPayload<Value: Codable & Sendable>: Codable, Sendable {
    let value: Value
    let capturedAt: Date
}

/// Somewhere a screen's last good payload survives the process.
///
/// The protocol exists so every store can be built from a fake — the same rule
/// `SnapshotStoring` follows, and for the same reason: a test that touched the
/// real Caches directory would be a test that passes or fails depending on
/// what the last test left behind.
protocol PayloadCaching<Value>: Sendable {
    associatedtype Value: Codable & Sendable
    func read() -> CachedPayload<Value>?
    func write(_ value: Value, at capturedAt: Date)
    func clear()
}

extension PayloadCaching {
    /// Sugar for the overwhelmingly common call — the store has just received
    /// a payload and wants it kept, dated now.
    func write(_ value: Value) { write(value, at: Date()) }
}

/// The real one: one JSON file per cache, under Caches.
///
/// **Caches, not Application Support**, and not the App Group container. Every
/// one of these is re-fetchable by definition, so the system evicting the lot
/// under disk pressure costs one request per screen and nothing else. The App
/// Group container is deliberately NOT used: it exists so a widget can read
/// the holdings snapshot, a widget reads exactly one payload, and putting the
/// other seven there would put purgeable data somewhere the system will not
/// purge. `AppGroupSnapshotStore` stays where it is and stays hand-written —
/// it has a second reader with its own file-protection needs, which is a
/// different problem from this one.
///
/// **Keyed by the contract fingerprint.** The filename carries
/// `ContractsVersion.current`, so the app update that changes a payload's
/// shape also changes where the cache lives, and yesterday's file is simply
/// not found rather than being decoded under new rules. A `Codable` decode
/// does not reliably refuse a changed shape — an added optional, or a field
/// that kept its name and changed its meaning, sails straight through — and on
/// a money screen that is worse than an empty state.
///
/// **A TTL, because old is not the same as useless.** Past it the file is
/// ignored and deleted; before it, the payload paints with its age attached
/// and the screen says how old it is.
struct DiskCache<Value: Codable & Sendable>: PayloadCaching {
    /// The subdirectory under Caches. One directory for all of them, so
    /// clearing on sign-out is one `removeItem` rather than a list that
    /// someone will forget to add to.
    static var directoryName: String { "payload-cache" }

    private let fileURL: URL?
    private let ttl: TimeInterval
    private let now: @Sendable () -> Date

    /// - Parameters:
    ///   - key: a stable name for the screen, e.g. `"watchlist"`. Anything
    ///     varying per screen instance — a ticker, a chart range — belongs in
    ///     here too, since one file per variant is what makes them independent.
    ///   - ttl: how long the payload may still be painted. There is no
    ///     universal right answer: quotes go stale in minutes, a list of
    ///     transactions is good for a week.
    init(
        key: String,
        ttl: TimeInterval,
        parent: URL? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.ttl = ttl
        self.now = now

        let caches = parent ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        guard let caches else {
            fileURL = nil
            return
        }
        let directory = caches.appending(path: DiskCache.directoryName)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Slashes and colons are legal in a ticker-shaped key (`BRK.B` is
        // fine, an option key like `AAPL 250117C00150000` less so) and illegal
        // in a filename. Percent-encoding rather than a hash so a directory
        // listing during development still says which screen a file belongs
        // to.
        let safe = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "unnamed"
        fileURL = directory.appending(path: "\(safe).\(ContractsVersion.current).json")
    }

    func read() -> CachedPayload<Value>? {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return nil }
        guard let cached = try? JSONDecoder.snapshot.decode(CachedPayload<Value>.self, from: data) else {
            // Undecodable is not a mystery worth keeping. The file cannot be
            // read by this build and never will be, and leaving it there means
            // paying a failed read on every launch forever.
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }

        let age = now().timeIntervalSince(cached.capturedAt)
        // A NEGATIVE age is a clock that moved backwards, not a payload from
        // the future. Treated as expired rather than as infinitely fresh:
        // "fresh forever" is the failure mode that would keep a wrong number
        // on screen indefinitely.
        guard age >= 0, age <= ttl else {
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }
        return cached
    }

    func write(_ value: Value, at capturedAt: Date) {
        guard let fileURL else { return }
        let payload = CachedPayload(value: value, capturedAt: capturedAt)
        guard let data = try? JSONEncoder.snapshot.encode(payload) else { return }
        // `.atomic` so a crash mid-write leaves the previous payload rather
        // than half of the new one. No file-protection option: unlike the
        // holdings snapshot there is no widget that has to read this on a
        // locked phone, so the default (complete protection) is right — this
        // is the user's portfolio sitting on a disk.
        try? data.write(to: fileURL, options: [.atomic])
    }

    func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Everything, in one call.
    ///
    /// Sign-out has to purge every cache, and a per-store list is a list
    /// someone adds a store to and forgets — the exact shape of bug where an
    /// account's dividends outlive its session. Removing the whole directory
    /// cannot be forgotten, because the next cache added lands inside it.
    static func clearAll(parent: URL? = nil) {
        let caches = parent ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        guard let caches else { return }
        try? FileManager.default.removeItem(at: caches.appending(path: DiskCache.directoryName))
    }
}

/// How long each screen's payload may still be shown.
///
/// Gathered in one place rather than spelled at each call site, because these
/// are a single decision seen from eight angles — how old is too old to paint
/// with a label on it — and eight scattered numbers would drift into eight
/// different opinions.
enum CacheTTL {
    /// Quotes and anything carrying them. Long enough to cover a night and a
    /// weekend, so a Monday-morning launch on the train paints Friday's close
    /// rather than a spinner; the bar says how old it is.
    static let quotes: TimeInterval = 3 * 24 * 60 * 60

    /// Things the user typed, which do not go stale on their own — a
    /// transaction from March is still a transaction. Capped anyway, because a
    /// list that has not been confirmed in a fortnight is more likely to be
    /// missing rows than to be right.
    static let ledger: TimeInterval = 14 * 24 * 60 * 60

    /// Intraday chart series. An hour: past that the shape is visibly wrong
    /// rather than merely old, and a wrong-shaped chart reads as data instead
    /// of as history.
    static let intradaySeries: TimeInterval = 60 * 60

    /// Daily ranges whose last point is today's still-forming session.
    /// An hour, not a day: a 24 h copy would paint yesterday-without-today
    /// on first launch after this ships, until the always-on refetch lands.
    static let formingDailySeries: TimeInterval = 60 * 60

    /// Completed daily series (analytics). The closes are immutable — that
    /// is why the server caches them permanently — so a day-old copy is
    /// still the same numbers.
    static let dailySeries: TimeInterval = 24 * 60 * 60

    /// Headlines. Old news is not wrong, it is just old, and a feed from
    /// yesterday is a fair thing to show while today's loads.
    static let news: TimeInterval = 24 * 60 * 60
}
