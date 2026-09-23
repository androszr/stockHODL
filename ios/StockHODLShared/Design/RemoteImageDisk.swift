import Foundation

/// Where a fetched picture survives the process.
///
/// The app's in-memory caches were sound while a debugger was attached and the
/// process never died. Off the cable it dies constantly — iOS suspends a
/// backgrounded app and reclaims it under pressure — and every relaunch was
/// re-fetching every brand icon, one bearer-guarded request each against a
/// cold function. On a desk that is free. On cellular it is why a portfolio
/// full of logos comes back as a wall of monograms.
///
/// A file per key rather than one archive: the writes are concurrent by nature
/// (a screen of tiles all arriving at once) and a single file would need a
/// lock around a whole rewrite for every icon.
///
/// A MISS is stored too, as a zero-byte file. Most of this portfolio has no
/// vendor icon, so without it every launch re-asks the server for a 404 it has
/// already given — which is the same reasoning `RemoteImageCache` uses for its
/// in-memory negative set, applied one layer down.
protocol RemoteImageStoring: Sendable {
    /// Non-nil empty data means a REMEMBERED MISS; nil means nothing known.
    func load(_ key: String) -> Data?
    /// Everything on disk, for warming the memory cache at launch.
    func loadAll() -> [String: Data]
    func save(_ data: Data, for key: String)
    func saveMiss(for key: String)
    func clear()
}

/// The real one: a directory under Caches, namespaced per cache.
///
/// Caches rather than Application Support because these are re-fetchable by
/// definition — the system may evict the lot under disk pressure and the only
/// cost is one request per icon. It is NOT the App Group container: a widget
/// draws no logos, and the sandbox that can be purged is the honest place for
/// something purgeable.
struct RemoteImageDisk: RemoteImageStoring {
    /// Images last a month, matching the `max-age` the logo route already
    /// sends (`src/lib/market-data/logo.ts`). Misses expire far sooner: a
    /// ticker the vendor had no icon for in March may well have one in April,
    /// and a permanent negative on disk would never find out.
    static let imageTTL: TimeInterval = 30 * 24 * 60 * 60
    static let missTTL: TimeInterval = 7 * 24 * 60 * 60

    private let directory: URL?

    init(namespace: String, parent: URL? = nil) {
        let caches = parent ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        guard let caches else {
            directory = nil
            return
        }
        let directory = caches.appending(path: "RemoteImages/\(namespace)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.directory = directory
    }

    /// Base64url of the key's bytes, so a symbol like `BRK.B` — or a publisher
    /// id with a slash in it — cannot escape the directory or collide with
    /// another key that sanitises to the same string.
    private func url(for key: String) -> URL? {
        directory?.appending(path: Data(key.utf8).base64URLEncodedString())
    }

    func load(_ key: String) -> Data? {
        guard let url = url(for: key),
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path(percentEncoded: false)),
              let modified = attributes[.modificationDate] as? Date,
              let data = try? Data(contentsOf: url)
        else { return nil }

        // An entry past its life is deleted rather than merely ignored, so a
        // cache of dead files cannot grow forever behind a ticker the user
        // stopped holding.
        guard Date().timeIntervalSince(modified) < (data.isEmpty ? Self.missTTL : Self.imageTTL) else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return data
    }

    func loadAll() -> [String: Data] {
        guard let directory,
              let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        else { return [:] }

        var out: [String: Data] = [:]
        for name in names {
            guard let key = String(base64URLEncoded: name), let data = load(key) else { continue }
            out[key] = data
        }
        return out
    }

    func save(_ data: Data, for key: String) {
        guard let url = url(for: key) else { return }
        try? data.write(to: url, options: .atomic)
    }

    func saveMiss(for key: String) {
        save(Data(), for: key)
    }

    func clear() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
}

/// Previews, tests, and anything that must not touch the file system.
struct NoImageDisk: RemoteImageStoring {
    func load(_: String) -> Data? { nil }
    func loadAll() -> [String: Data] { [:] }
    func save(_: Data, for _: String) {}
    func saveMiss(for _: String) {}
    func clear() {}
}

// MARK: - Filename encoding

private extension Data {
    /// Base64 with the two filename-hostile characters swapped and the padding
    /// dropped — the same alphabet the WebAuthn code uses, spelled locally
    /// because this one is about file names, not about credentials.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension String {
    init?(base64URLEncoded name: String) {
        var padded = name
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        guard let data = Data(base64Encoded: padded), let decoded = String(data: data, encoding: .utf8) else {
            return nil
        }
        self = decoded
    }
}
