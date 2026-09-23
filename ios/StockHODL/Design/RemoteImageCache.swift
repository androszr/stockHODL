import UIKit

/// What a fetch attempt actually established.
///
/// This is an enum rather than `Data?` because the cache below REMEMBERS a
/// nil, and the three ways a picture can fail to arrive do not deserve the
/// same memory:
///
///  - `.absent` — the server answered, and its answer was "there is no
///    picture here" (a 404). Definitive. Worth remembering forever, which is
///    the entire reason the negative set exists.
///  - `.failed` — the request never got an answer: offline, timed out, or —
///    the case that made this type necessary — the tile scrolled off screen
///    and SwiftUI cancelled its `.task`. Nothing was learned, so nothing may
///    be remembered.
///
/// Conflating the two is not a theoretical tidiness: with `Data?` a logo whose
/// request was cancelled mid-scroll was filed as permanently missing and never
/// requested again for the life of the process, so an arbitrary handful of
/// tickers showed a monogram until the app was force-quit — while the server
/// logs showed a cheerful 200 for every one of them.
enum RemoteImageOutcome: Sendable {
    case bytes(Data)
    case absent
    case failed
}

/// Fetch once, keep forever — for the lifetime of the process.
///
/// Extracted from `LogoLoader` when the news screens arrived (2026-08-18) and
/// needed the identical algorithm for hero images and publisher marks. It is
/// one algorithm because the awkward part is not the fetching:
///
/// TWO caches, because a MISS is as worth remembering as a hit. Most of this
/// portfolio has no vendor icon, and most publishers have no usable logo —
/// without the negative set every scroll re-asks the server for a 404 it has
/// already given. That is the whole reason this type exists rather than a
/// dictionary at each call site. Only a DEFINITIVE miss is remembered; see
/// `RemoteImageOutcome`.
///
/// `NSLock` rather than an actor so `cached()` can answer SYNCHRONOUSLY inside
/// a view's body: an `await` there is exactly the fade-in-on-every-scroll this
/// design avoids.
///
/// Not deduped across concurrent callers for the same key. Two tiles racing on
/// one key costs one extra request and settles on the same bytes; a request
/// registry to save it would be more moving parts than the saving is worth.
final class RemoteImageCache: @unchecked Sendable {
    private let lock = NSLock()
    private var images: [String: UIImage] = [:]
    private var missing: Set<String> = []
    private let fetch: @Sendable (String) async -> RemoteImageOutcome
    /// The half that survives the process — see `RemoteImageDisk` for why a
    /// memory-only cache was fine on the cable and useless off it.
    private let disk: any RemoteImageStoring

    init(
        namespace: String,
        disk: (any RemoteImageStoring)? = nil,
        fetch: @escaping @Sendable (String) async -> RemoteImageOutcome
    ) {
        self.fetch = fetch
        self.disk = disk ?? RemoteImageDisk(namespace: namespace)
        warm()
    }

    /// Decode everything already on disk into memory, off the main actor, so
    /// the first frame of a tile paints opaque instead of fading in.
    ///
    /// Detached rather than awaited: a launch must not wait on a directory,
    /// and a tile that renders before this finishes simply takes the
    /// `image(for:)` path and finds the same bytes.
    private func warm() {
        let disk = disk
        Task.detached(priority: .utility) { [weak self] in
            let stored = disk.loadAll()
            guard !stored.isEmpty else { return }
            var decoded: [String: UIImage] = [:]
            var absent: Set<String> = []
            for (key, data) in stored {
                if data.isEmpty {
                    absent.insert(key)
                } else if let image = UIImage(data: data) {
                    decoded[key] = image
                }
            }
            self?.merge(images: decoded, missing: absent)
        }
    }

    /// Disk loses to anything the process has already learned: a fetch that
    /// finished while the warm was in flight is the fresher fact.
    private func merge(images decoded: [String: UIImage], missing absent: Set<String>) {
        lock.withLock {
            images.merge(decoded) { existing, _ in existing }
            missing.formUnion(absent.subtracting(Set(images.keys)))
        }
    }

    func cached(_ key: String) -> UIImage? {
        lock.withLock { images[key] }
    }

    func image(for key: String) async -> UIImage? {
        let known = lock.withLock { () -> (UIImage?, Bool) in
            (images[key], missing.contains(key))
        }
        if let hit = known.0 { return hit }
        if known.1 { return nil }

        // Disk before network, and off the calling actor: this runs from a
        // view's `.task`, which is the main one, and a file read plus a
        // decode there is a dropped frame per tile.
        if let stored = await read(key) {
            switch stored {
            case let .bytes(data):
                if let decoded = UIImage(data: data) {
                    lock.withLock { images[key] = decoded }
                    return decoded
                }
            case .absent:
                lock.withLock { _ = missing.insert(key) }
                return nil
            case .failed:
                break
            }
        }

        switch await fetch(key) {
        case let .bytes(data):
            guard let decoded = UIImage(data: data) else {
                // Undecodable bytes ARE definitive: a publisher serving an SVG
                // under an allowlisted type will serve the same SVG next time.
                lock.withLock { _ = missing.insert(key) }
                disk.saveMiss(for: key)
                return nil
            }
            lock.withLock { images[key] = decoded }
            disk.save(data, for: key)
            return decoded

        case .absent:
            lock.withLock { _ = missing.insert(key) }
            disk.saveMiss(for: key)
            return nil

        case .failed:
            // Deliberately not remembered — the next appearance tries again.
            return nil
        }
    }

    /// What disk knows about this key, in the same three shapes a fetch
    /// answers in: bytes, a remembered miss, or nothing learned.
    private func read(_ key: String) async -> RemoteImageOutcome? {
        let disk = disk
        return await Task.detached(priority: .userInitiated) { () -> RemoteImageOutcome? in
            guard let data = disk.load(key) else { return nil }
            return data.isEmpty ? .absent : .bytes(data)
        }.value
    }

    /// Sign-out clears these with everything else derived from the account.
    /// Pictures are not secret, but a screen still holding the previous
    /// session's images is the kind of leftover that makes a purge look like
    /// it did not happen.
    func purge() {
        lock.withLock {
            images.removeAll()
            missing.removeAll()
        }
        disk.clear()
    }
}
