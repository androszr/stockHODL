import Foundation
import Testing

@testable import StockHODL

/// base64url is the encoding the whole ceremony rides on, and every way it can
/// be wrong produces a server error that names something else. These cases pin
/// the three differences from standard base64 rather than trusting them.
@Suite("Base64URL")
struct Base64URLTests {
    /// Bytes chosen so that standard base64 must emit both `+` and `/`:
    /// 0xFB 0xFF gives "+/" in the alphabet. If the substitution were missing,
    /// this is the test that notices.
    private let awkward = Data([0xFB, 0xFF, 0xBF, 0x00, 0x10, 0x83])

    @Test("uses the URL alphabet, never + or /")
    func alphabet() {
        let encoded = Base64URL.encode(awkward)
        #expect(!encoded.contains("+"))
        #expect(!encoded.contains("/"))
        #expect(encoded.contains("-") || encoded.contains("_"))
    }

    @Test("drops padding")
    func noPadding() {
        // One and two leftover bytes are the two padded cases.
        #expect(!Base64URL.encode(Data([0x01])).contains("="))
        #expect(!Base64URL.encode(Data([0x01, 0x02])).contains("="))
    }

    @Test("round-trips every length up to a full block boundary")
    func roundTrip() {
        for length in 0...16 {
            let data = Data((0..<length).map { UInt8(truncatingIfNeeded: $0 * 37 + 11) })
            #expect(Base64URL.decode(Base64URL.encode(data)) == data, "length \(length)")
        }
    }

    @Test("decodes a value that arrived with padding anyway")
    func tolerantOfPadding() {
        // Some servers pad. Refusing that would be a correctness bug dressed as
        // strictness — the bytes are unambiguous either way.
        #expect(Base64URL.decode("AQ==") == Data([0x01]))
        #expect(Base64URL.decode("AQ") == Data([0x01]))
    }

    @Test("refuses what is not base64url rather than returning empty data")
    func rejectsGarbage() {
        // The distinction matters: empty Data would be handed to the
        // authenticator as a challenge and produce a signature over nothing.
        #expect(Base64URL.decode("!!!!") == nil)
        #expect(Base64URL.decode("A") == nil)
    }

    @Test("a 32-byte challenge encodes to the 43 characters the wire carries")
    func challengeShape() {
        let challenge = Data(repeating: 0x5A, count: 32)
        #expect(Base64URL.encode(challenge).count == 43)
    }
}
