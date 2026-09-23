import Foundation
import Testing

@testable import StockHODL

/// The real `DiskCache`, driven against a throwaway directory.
///
/// Not a fake, deliberately: everything interesting here is filesystem
/// behaviour — a file that outlives an app update, a TTL measured against a
/// clock, a filename derived from a contract fingerprint — and none of it
/// would be exercised by an in-memory stand-in. Each test gets its own
/// directory under the system temp so two running in parallel cannot see each
/// other's files, which is the same rule the stores' tests follow with
/// `FakePayloadCache`.
@Suite("Disk cache")
struct DiskCacheTests {
    private struct Payload: Codable, Sendable, Equatable {
        let value: String
    }

    private static func directory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "diskcache-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("what goes in comes back out, with the instant it was written")
    func roundTrips() {
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        // A clock pinned beside the payload's own instant: with the real one,
        // a fixture dated 2023 is two years past any TTL and the read is a
        // correct miss rather than the round trip under test.
        let cache = DiskCache<Payload>(
            key: "round",
            ttl: 3600,
            parent: Self.directory(),
            now: { taken.addingTimeInterval(60) }
        )

        cache.write(Payload(value: "hello"), at: taken)

        let read = cache.read()
        #expect(read?.value == Payload(value: "hello"))
        #expect(read?.capturedAt == taken)
    }

    @Test("a payload past its TTL is a miss, and is deleted rather than re-read forever")
    func expiredIsAMiss() {
        let directory = Self.directory()
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        let writer = DiskCache<Payload>(key: "expiry", ttl: 60, parent: directory)
        writer.write(Payload(value: "old"), at: taken)

        // The same file, read by a cache whose clock is two minutes later.
        let reader = DiskCache<Payload>(
            key: "expiry",
            ttl: 60,
            parent: directory,
            now: { taken.addingTimeInterval(120) }
        )

        #expect(reader.read() == nil)
        // And gone: leaving it means paying a failed read on every launch for
        // the life of the install.
        #expect(writer.read() == nil)
    }

    @Test("a clock that moved backwards is treated as expired, not as fresh forever")
    func futureIsExpired() {
        let directory = Self.directory()
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        let writer = DiskCache<Payload>(key: "clock", ttl: 60, parent: directory)
        writer.write(Payload(value: "future"), at: taken)

        let reader = DiskCache<Payload>(
            key: "clock",
            ttl: 60,
            parent: directory,
            now: { taken.addingTimeInterval(-3600) }
        )

        // "Fresh forever" is the failure mode worth refusing: it would keep a
        // wrong number on screen indefinitely with no way to shift it.
        #expect(reader.read() == nil)
    }

    @Test("an undecodable file is a miss and is removed")
    func corruptIsDiscarded() {
        let directory = Self.directory()
        let cache = DiskCache<Payload>(key: "corrupt", ttl: 3600, parent: directory)
        cache.write(Payload(value: "good"), at: Date())

        let file = try! #require(
            try? FileManager.default.contentsOfDirectory(
                at: directory.appending(path: DiskCache<Payload>.directoryName),
                includingPropertiesForKeys: nil
            ).first
        )
        try! Data("not json".utf8).write(to: file)

        #expect(cache.read() == nil)
        #expect(!FileManager.default.fileExists(atPath: file.path()))
    }

    @Test("the filename carries the contract fingerprint")
    func keyedByContractVersion() {
        let directory = Self.directory()
        let cache = DiskCache<Payload>(key: "versioned", ttl: 3600, parent: directory)
        cache.write(Payload(value: "v1"), at: Date())

        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory.appending(path: DiskCache<Payload>.directoryName),
            includingPropertiesForKeys: nil
        )) ?? []

        // This is what makes an app update a cache MISS rather than a silent
        // reinterpretation: a `Codable` decode does not reliably refuse a
        // changed shape, and on a money screen a wrong number is worse than an
        // empty one.
        #expect(files.contains { $0.lastPathComponent.contains(ContractsVersion.current) })
    }

    @Test("a key with characters no filename allows still round-trips")
    func awkwardKeysAreSafe() {
        let directory = Self.directory()
        // Option keys look like this, and `BRK.B` is an ordinary ticker.
        let cache = DiskCache<Payload>(key: "AAPL 250117C00150000/1D", ttl: 3600, parent: directory)

        cache.write(Payload(value: "ok"), at: Date())

        #expect(cache.read()?.value == Payload(value: "ok"))
    }

    @Test("two keys are two files")
    func keysAreIndependent() {
        let directory = Self.directory()
        let one = DiskCache<Payload>(key: "one", ttl: 3600, parent: directory)
        let two = DiskCache<Payload>(key: "two", ttl: 3600, parent: directory)

        one.write(Payload(value: "first"), at: Date())
        two.write(Payload(value: "second"), at: Date())

        #expect(one.read()?.value == Payload(value: "first"))
        #expect(two.read()?.value == Payload(value: "second"))
    }

    @Test("clearAll takes every cache, including ones nothing holds a reference to")
    func clearAllRemovesEverything() {
        let directory = Self.directory()
        let one = DiskCache<Payload>(key: "one", ttl: 3600, parent: directory)
        let two = DiskCache<Payload>(key: "two", ttl: 3600, parent: directory)
        one.write(Payload(value: "first"), at: Date())
        two.write(Payload(value: "second"), at: Date())

        // The sign-out guarantee. A per-store list of caches to clear is a
        // list someone adds a store to and forgets; a directory is not.
        DiskCache<Payload>.clearAll(parent: directory)

        #expect(one.read() == nil)
        #expect(two.read() == nil)
    }

    @Test("a write replaces the previous payload rather than accumulating")
    func writesReplace() {
        let cache = DiskCache<Payload>(key: "replace", ttl: 3600, parent: Self.directory())

        cache.write(Payload(value: "first"), at: Date())
        cache.write(Payload(value: "second"), at: Date())

        #expect(cache.read()?.value == Payload(value: "second"))
    }
}

@Suite("Reachability")
@MainActor
struct ReachabilityTests {
    @Test("it starts optimistic")
    func startsConnected() {
        // A monitor takes a moment to deliver its first path, and starting at
        // `false` would flash an offline banner over every cold launch.
        #expect(Reachability().isConnected)
    }

    @Test("a path update moves the flag in both directions")
    func tracksThePath() {
        let reachability = Reachability()

        reachability.apply(connected: false)
        #expect(!reachability.isConnected)

        reachability.apply(connected: true)
        #expect(reachability.isConnected)
    }

    @Test("an unchanged path is not republished")
    func unchangedIsIgnored() {
        let reachability = Reachability()
        reachability.apply(connected: false)

        // `NWPathMonitor` republishes the same path on unrelated interface
        // changes several times a minute, and `@Observable` tracks WRITES
        // rather than differences — so every one of those would invalidate
        // every view reading the flag.
        reachability.apply(connected: false, expensive: true)

        #expect(!reachability.isConnected)
        #expect(reachability.isExpensive, "the interface fact still updates")
    }
}
