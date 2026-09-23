import Foundation

/// base64url, the encoding WebAuthn speaks — and the single most likely place
/// for this stage to go wrong quietly.
///
/// `AuthenticationServices` hands back plain `Data`. Better Auth (through
/// SimpleWebAuthn) reads and writes base64url without padding: `+` becomes `-`,
/// `/` becomes `_`, and the trailing `=` are dropped. Standard base64 differs
/// from it in exactly those three ways, so a mix-up produces a value that looks
/// right in a log and fails verification with nothing more specific than
/// "authentication failed".
///
/// The stored credential ID is the sharpest case: the server looks a passkey up
/// by string equality on `credentialID`, so one wrong character is not a
/// signature error but a "passkey not found" — a different message pointing at
/// a different, imaginary problem.
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// `nil` when the input is not valid base64url. A caller that receives nil
    /// is looking at a malformed challenge, and continuing with an empty `Data`
    /// would ask the user for Face ID against a challenge the server never
    /// issued.
    static func decode(_ string: String) -> Data? {
        var s = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        // Restore the padding base64url dropped. Length % 4 == 1 is impossible
        // for real base64, so it falls through to the initializer's own nil.
        let remainder = s.count % 4
        if remainder > 0 { s += String(repeating: "=", count: 4 - remainder) }

        return Data(base64Encoded: s)
    }
}
