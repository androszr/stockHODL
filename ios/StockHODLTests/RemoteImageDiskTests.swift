import Foundation
import Testing
import UIKit

@testable import StockHODL

/// A directory of its own per test, deleted afterwards: these cases are about
/// what survives a process, so they must not survive each other.
private func temporaryParent() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appending(path: "RemoteImageDiskTests/\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func onePixelPNG() -> Data {
    UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).pngData { context in
        UIColor.gray.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
    }
}

/// Local to this file — `DesignTests` keeps its own for the same reason: a
/// shared test helper across suites is shared mutable state in a test bundle
/// that runs them in parallel.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func bump() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

@Suite("Remote image disk")
struct RemoteImageDiskTests {
    @Test("bytes written by one cache are found by the next one")
    func survivesTheProcess() async {
        // The whole point. Off the debugger iOS reclaims the app constantly,
        // and before this every relaunch re-fetched every brand icon — which
        // on cellular is why a portfolio came back as a wall of monograms.
        let parent = temporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let bytes = onePixelPNG()

        let first = LogoLoader(disk: RemoteImageDisk(namespace: "logos", parent: parent)) { _ in .bytes(bytes) }
        #expect(await first.image(for: "AAPL") != nil)

        let calls = Counter()
        let second = LogoLoader(disk: RemoteImageDisk(namespace: "logos", parent: parent)) { _ in
            calls.bump()
            return .bytes(bytes)
        }
        #expect(await second.image(for: "AAPL") != nil)
        #expect(calls.value == 0)
    }

    @Test("a definitive miss survives too")
    func remembersMissesAcrossProcesses() async {
        // Most of this portfolio has no vendor icon. A miss that lived only in
        // memory meant every launch re-asked the server for the same 404s.
        let parent = temporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }

        let first = LogoLoader(disk: RemoteImageDisk(namespace: "logos", parent: parent)) { _ in .absent }
        #expect(await first.image(for: "CDR.WA") == nil)

        let calls = Counter()
        let second = LogoLoader(disk: RemoteImageDisk(namespace: "logos", parent: parent)) { _ in
            calls.bump()
            return .absent
        }
        #expect(await second.image(for: "CDR.WA") == nil)
        #expect(calls.value == 0)
    }

    @Test("a request that never finished is not written at all")
    func doesNotRememberFailures() async {
        let parent = temporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let disk = RemoteImageDisk(namespace: "logos", parent: parent)

        let loader = LogoLoader(disk: disk) { _ in .failed }
        #expect(await loader.image(for: "GOOGL") == nil)

        // Nothing learned, so nothing may be remembered — the same rule the
        // memory cache follows, and the reason `RemoteImageOutcome` has three
        // cases rather than being `Data?`.
        #expect(disk.load("GOOGL") == nil)
    }

    @Test("an entry past its life is dropped rather than served")
    func expires() throws {
        let parent = temporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let disk = RemoteImageDisk(namespace: "logos", parent: parent)
        disk.save(onePixelPNG(), for: "AAPL")

        // Reach into the file and age it. The alternative — an injected clock
        // — would be a seam through four types for one assertion.
        let directory = parent.appending(path: "RemoteImages/logos", directoryHint: .isDirectory)
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        let entry = try #require(names.first)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-RemoteImageDisk.imageTTL - 60)],
            ofItemAtPath: directory.appending(path: entry).path(percentEncoded: false)
        )

        #expect(disk.load("AAPL") == nil)
        // Deleted, not merely ignored: a cache of dead files behind tickers
        // the user stopped holding would grow forever.
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false)).isEmpty)
    }

    @Test("a symbol with a dot or a slash stays inside the directory")
    func encodesKeys() {
        // `BRK.B` is ordinary and a publisher id can carry anything. A key
        // spliced into a path is how a cache writes outside itself.
        let parent = temporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let disk = RemoteImageDisk(namespace: "logos", parent: parent)

        for key in ["BRK.B", "../escape", "a/b"] {
            disk.save(Data([0x01]), for: key)
            #expect(disk.load(key) == Data([0x01]))
        }

        let directory = parent.appending(path: "RemoteImages/logos", directoryHint: .isDirectory)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))) ?? []
        #expect(names.count == 3)
    }

    @Test("sign-out takes the pictures with it")
    func purgeClearsTheDirectory() async {
        let parent = temporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let disk = RemoteImageDisk(namespace: "logos", parent: parent)
        let bytes = onePixelPNG()

        let loader = LogoLoader(disk: disk) { _ in .bytes(bytes) }
        #expect(await loader.image(for: "AAPL") != nil)
        loader.purge()

        #expect(disk.load("AAPL") == nil)
        #expect(disk.loadAll().isEmpty)
    }

    @Test("two namespaces do not share a file")
    func namespacesAreSeparate() {
        let parent = temporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }

        let logos = RemoteImageDisk(namespace: "logos", parent: parent)
        let publishers = RemoteImageDisk(namespace: "publishers", parent: parent)
        logos.save(Data([0x01]), for: "shared-key")

        #expect(publishers.load("shared-key") == nil)
    }
}
