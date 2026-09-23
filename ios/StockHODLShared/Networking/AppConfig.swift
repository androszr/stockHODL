import Foundation

/// Where this build points, and the relying party it authenticates against.
///
/// Both come from the bundle rather than from a Swift literal: `APIBaseURL` is
/// expanded from `API_BASE_URL` in the per-configuration xcconfig, so a Debug
/// build talks to `pnpm dev` and a Release build talks to production without a
/// conditional anywhere in the code (plan B.4).
struct AppConfig: Sendable {
    let baseURL: URL

    /// The WebAuthn relying party — always the API host. It is derived rather
    /// than configured because the two can never legitimately differ: a passkey
    /// is scoped to the domain that issued it, so an rpID that did not match
    /// the host would simply mean no credential is ever found.
    ///
    /// Consequence worth knowing before it bites (plan B.6): moving to a custom
    /// domain invalidates every existing passkey. That is a re-registration on
    /// the web, not a rename here.
    var relyingPartyID: String { baseURL.host() ?? "" }

    /// The `Origin` this client claims on a write, matching what the server
    /// computes from `BETTER_AUTH_URL` (`src/lib/api/mobile/respond.ts`).
    ///
    /// Built from the parts rather than taken from `absoluteString`, because a
    /// base URL written with a trailing slash in the xcconfig would otherwise
    /// produce `https://host/` — which is not equal to `https://host`, and
    /// would turn every POST into a 401 for a reason nothing in the response
    /// would name.
    var origin: String {
        var origin = "\(baseURL.scheme ?? "https")://\(baseURL.host() ?? "")"
        if let port = baseURL.port { origin += ":\(port)" }
        return origin
    }

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Which APNs certificate environment this build's push tokens are valid
    /// under — Apple issues sandbox and production tokens from different
    /// pools, so the server needs to know which one a token came from.
    /// `#if DEBUG` rather than deriving it from `baseURL` the way
    /// `relyingPartyID` does: a Debug build on a device still talks to
    /// production (`Debug.xcconfig`'s `API_BASE_URL[sdk=iphoneos*]`), but its
    /// push entitlement is still the development one Xcode signs Debug builds
    /// with.
    var pushEnvironment: PushTokenEnvironment {
        #if DEBUG
            .sandbox
        #else
            .production
        #endif
    }

    enum ConfigError: Error, CustomStringConvertible {
        case missingKey
        case malformed(String)

        var description: String {
            switch self {
            case .missingKey:
                "APIBaseURL is absent from Info.plist — check INFOPLIST_FILE and API_BASE_URL in Config/*.xcconfig."
            case let .malformed(value):
                "APIBaseURL is not a usable URL: \(value)"
            }
        }
    }

    static func load(from bundle: Bundle) throws -> AppConfig {
        guard let raw = bundle.object(forInfoDictionaryKey: "APIBaseURL") as? String else {
            throw ConfigError.missingKey
        }
        // An unexpanded `$(API_BASE_URL)` parses as a perfectly valid relative
        // URL, so checking for a host is what actually catches a broken
        // xcconfig — and catches it here rather than as a confusing 404.
        guard let url = URL(string: raw), url.host() != nil else {
            throw ConfigError.malformed(raw)
        }
        return AppConfig(baseURL: url)
    }

    /// Resolved once, lazily. A failure here is a build-configuration mistake
    /// that no runtime handling can repair, and every screen would have to
    /// render the same dead end — so it stops the app with the reason attached.
    static let current: AppConfig = {
        do {
            return try load(from: .main)
        } catch {
            fatalError("\(error)")
        }
    }()
}
