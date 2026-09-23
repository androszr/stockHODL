import Foundation
import Testing

@testable import StockHODL

/// The JSON contract with `@better-auth/passkey` / SimpleWebAuthn.
///
/// Nothing here is our schema, so nothing here is generated — which means the
/// field names are a hand-copied constant, and a hand-copied constant with no
/// test is a typo waiting for a device to find it. Plan A.9 names this exact
/// splice as the most likely place for the stage to stall, so it is pinned.
@Suite("WebAuthn")
struct WebAuthnTests {
    /// A verbatim-shaped response from
    /// `GET /api/auth/passkey/generate-authenticate-options`. Note what the
    /// plugin does NOT send: `allowCredentials[].type`. Typing it as required
    /// would fail decoding on a perfectly good response.
    private let optionsJSON = """
    {
      "challenge": "dGhpcy1pcy1hLTMyLWJ5dGUtY2hhbGxlbmdlLXZhbA",
      "timeout": 60000,
      "rpId": "sawa-finance.vercel.app",
      "allowCredentials": [
        { "id": "AQIDBA", "transports": ["internal", "hybrid"] }
      ],
      "userVerification": "preferred",
      "extensions": { "credProps": true }
    }
    """

    // MARK: - Options

    @Test("decodes the options the plugin actually sends")
    func decodesOptions() throws {
        let options = try JSONDecoder().decode(
            PasskeyRequestOptions.self,
            from: Data(optionsJSON.utf8)
        )

        #expect(options.rpID == "sawa-finance.vercel.app")
        #expect(options.timeout == 60000)
        #expect(options.userVerification == "preferred")
        #expect(options.challengeData != nil)
        #expect(options.allowedCredentialData == [Data([0x01, 0x02, 0x03, 0x04])])
    }

    @Test("decodes options with no allowCredentials")
    func decodesWithoutAllowList() throws {
        // The plugin omits the key entirely when it cannot tell who is asking,
        // and that means "any credential for this relying party" — which the
        // controller has to distinguish from an empty list meaning "none".
        let json = #"{ "challenge": "AQIDBA", "rpId": "example.com" }"#
        let options = try JSONDecoder().decode(
            PasskeyRequestOptions.self,
            from: Data(json.utf8)
        )

        #expect(options.allowCredentials == nil)
        #expect(options.allowedCredentialData.isEmpty)
    }

    @Test("a challenge that is not base64url decodes to nil, not to empty data")
    func rejectsBadChallenge() throws {
        let json = #"{ "challenge": "!!!not-base64!!!", "rpId": "example.com" }"#
        let options = try JSONDecoder().decode(
            PasskeyRequestOptions.self,
            from: Data(json.utf8)
        )

        // Empty data here would mean asking the user for Face ID over a
        // challenge the server never issued, and getting a signature that can
        // only fail verification.
        #expect(options.challengeData == nil)
    }

    @Test("drops one malformed entry from the allow list without failing the ceremony")
    func tolerantAllowList() throws {
        let json = """
        { "challenge": "AQIDBA", "rpId": "example.com",
          "allowCredentials": [{ "id": "!!!" }, { "id": "AQIDBA" }] }
        """
        let options = try JSONDecoder().decode(
            PasskeyRequestOptions.self,
            from: Data(json.utf8)
        )

        #expect(options.allowedCredentialData == [Data([0x01, 0x02, 0x03, 0x04])])
    }

    // MARK: - Assertion

    private func encodedAssertion() throws -> [String: Any] {
        let assertion = PasskeyAssertion(
            credentialID: Data([0xFB, 0xFF, 0x01]),
            clientDataJSON: Data("{\"type\":\"webauthn.get\"}".utf8),
            authenticatorData: Data([0xAA, 0xBB]),
            signature: Data([0xCC, 0xDD]),
            userHandle: Data([0xEE])
        )
        let body = try JSONEncoder().encode(VerifyAuthenticationBody(response: assertion))
        let object = try JSONSerialization.jsonObject(with: body)
        let root = try #require(object as? [String: Any])
        return try #require(root["response"] as? [String: Any])
    }

    @Test("wraps the assertion in the envelope the endpoint expects")
    func envelope() throws {
        let body = try JSONEncoder().encode(VerifyAuthenticationBody(
            response: PasskeyAssertion(
                credentialID: Data([0x01]),
                clientDataJSON: Data([0x02]),
                authenticatorData: Data([0x03]),
                signature: Data([0x04]),
                userHandle: nil
            )
        ))
        let root = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])

        // `{ response: ... }`, not the assertion at the top level. The endpoint
        // body schema is `z.object({ response: ... })` and a flat body is a 400
        // that says nothing about which shape was wanted.
        #expect(Array(root.keys) == ["response"])
    }

    @Test("uses exactly the field names SimpleWebAuthn reads")
    func fieldNames() throws {
        let response = try encodedAssertion()

        #expect(Set(response.keys) == [
            "id", "rawId", "type", "authenticatorAttachment",
            "clientExtensionResults", "response",
        ])

        let inner = try #require(response["response"] as? [String: Any])
        #expect(Set(inner.keys) == [
            "clientDataJSON", "authenticatorData", "signature", "userHandle",
        ])
    }

    @Test("id and rawId are the same base64url string")
    func idsAgree() throws {
        let response = try encodedAssertion()

        // The server finds the passkey by string equality on `id`. Standard
        // base64 here yields "passkey not found" — a message that points at a
        // missing credential rather than at an encoding mistake.
        #expect(response["id"] as? String == "-_8B")
        #expect(response["rawId"] as? String == "-_8B")
        #expect(response["type"] as? String == "public-key")
    }

    @Test("encodes every binary field as base64url")
    func binaryFields() throws {
        let inner = try #require(try encodedAssertion()["response"] as? [String: Any])

        #expect(inner["authenticatorData"] as? String == Base64URL.encode(Data([0xAA, 0xBB])))
        #expect(inner["signature"] as? String == Base64URL.encode(Data([0xCC, 0xDD])))
        #expect(inner["userHandle"] as? String == Base64URL.encode(Data([0xEE])))
        // clientDataJSON goes over the wire as base64url of the RAW bytes, not
        // as the JSON object it contains — the signature is over those bytes,
        // so re-encoding it would invalidate the assertion.
        #expect(
            inner["clientDataJSON"] as? String
                == Base64URL.encode(Data("{\"type\":\"webauthn.get\"}".utf8))
        )
    }

    @Test("omits userHandle when the authenticator did not supply one")
    func optionalUserHandle() throws {
        let assertion = PasskeyAssertion(
            credentialID: Data([0x01]),
            clientDataJSON: Data([0x02]),
            authenticatorData: Data([0x03]),
            signature: Data([0x04]),
            userHandle: nil
        )
        let data = try JSONEncoder().encode(assertion)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let inner = try #require(object["response"] as? [String: Any])

        #expect(inner["userHandle"] == nil)
    }
}
