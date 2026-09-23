import Foundation
import Testing

@testable import StockHODL

/// The SSE frame parser.
///
/// Worth testing on its own because it is the one part of the live path that
/// can be exercised against a literal string, and because every way it can be
/// subtly wrong — a dropped ping, a mis-stripped space, a frame emitted before
/// its blank line — produces a stream that looks connected and delivers
/// nothing.
@Suite("SSE parser")
struct SSEParserTests {
    /// Feeds a whole wire fragment and collects what came out.
    private func events(_ wire: String) -> [LiveEvent] {
        var parser = SSEParser<LivePayload>()
        var out: [LiveEvent] = []
        // `separator:omittingEmptySubsequences: false` matters: the blank line
        // IS the frame terminator, and dropping it would mean nothing ever
        // completes.
        for line in wire.split(separator: "\n", omittingEmptySubsequences: false) {
            if let event = parser.consume(line: String(line)) { out.append(event) }
        }
        return out
    }

    @Test("emits nothing until the blank line that terminates the frame")
    func needsTerminator() {
        var parser = SSEParser<LivePayload>()
        #expect(parser.consume(line: "event: bye") == nil)
        #expect(parser.consume(line: #"data: {"reason":"lifetime"}"#) == nil)

        guard case .bye(let reason) = parser.consume(line: "") else {
            Issue.record("expected a bye once the frame closed")
            return
        }
        #expect(reason == "lifetime")
    }

    @Test("ignores comment pings")
    func ignoresPings() {
        // `: ping` keeps intermediaries from reaping an idle stream and means
        // nothing to us — but a parser that treated it as data would corrupt
        // the frame it lands in the middle of.
        let wire = """
        : ping

        event: idle
        data: {"pollingResumesAtMs":1760000000000}

        """
        let out = events(wire)
        #expect(out.count == 1)
        guard case .idle(let resumes) = out.first else {
            Issue.record("expected idle")
            return
        }
        #expect(resumes == 1_760_000_000_000)
    }

    @Test("decodes a payload frame into a usable LivePayload")
    func decodesPayload() throws {
        let payload = LiveFixture.payload(totalValue: "1 000,00 PLN")
        let json = try String(data: JSONEncoder().encode(payload), encoding: .utf8) ?? ""

        let out = events("event: payload\ndata: \(json)\n\n")
        guard case .payload(let decoded) = try #require(out.first) else {
            Issue.record("expected a payload")
            return
        }
        #expect(decoded.summary.totalValue == "1 000,00 PLN")
    }

    @Test("strips exactly one leading space, not arbitrary whitespace")
    func oneSpaceOnly() {
        // The spec strips a single optional space after the colon. Trimming
        // more would corrupt any payload that legitimately begins with one.
        var parser = SSEParser<LivePayload>()
        _ = parser.consume(line: "event:bye")
        _ = parser.consume(line: #"data:{"reason":"no-quotes"}"#)
        guard case .bye(let reason) = parser.consume(line: "") else {
            Issue.record("a frame without spaces after the colon is still valid")
            return
        }
        #expect(reason == "no-quotes")
    }

    @Test("an unknown event is skipped rather than treated as a failure")
    func unknownEvent() {
        // The server may learn to send more than this build reads; that is not
        // an error, and certainly not a reason to tear down the stream.
        #expect(events("event: weather\ndata: {\"sunny\":true}\n\n").isEmpty)
    }

    @Test("several frames in one chunk all come out, in order")
    func multipleFrames() {
        let wire = """
        event: fallback
        data: {"reason":"vendor"}

        event: bye
        data: {"reason":"lifetime"}

        """
        let out = events(wire)
        #expect(out.count == 2)
        guard case .fallback = out.first, case .bye = out.last else {
            Issue.record("expected fallback then bye, got \(out)")
            return
        }
    }

    @Test("a frame with an event but no data produces nothing")
    func emptyData() {
        // Guards against emitting a `.bye(nil)` for a stray `event:` line,
        // which would end the pump on noise.
        #expect(events("event: bye\n\n").isEmpty)
    }
}
