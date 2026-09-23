import Foundation

/// Everything that can go wrong on the wire, kept separate from what the user
/// is told about it. The UI deliberately collapses most of these into one
/// message (see `AuthStore`); this type exists so a log can say which one it
/// actually was.
enum APIError: Error {
    case transport(Error)
    case http(status: Int, message: String?)
    case decoding(Error)
    /// The server accepted the credential but sent no `set-auth-token`. In
    /// practice this means the request reached Better Auth without declaring
    /// itself native, so the header was stripped on the way out
    /// (src/app/api/auth/[...all]/route.ts).
    case missingSessionToken
}

/// One request, described rather than assembled inline, so the two things that
/// must never be forgotten — the native-client header and the base URL — cannot
/// be forgotten at a call site.
struct APIRequest: Sendable {
    var method: String = "GET"
    var path: String
    /// Query parameters, assembled through `URLComponents` rather than spliced
    /// into `path`. `URL.appending(path:)` percent-encodes what it is given, so
    /// a hand-built `"…?range=1D"` would arrive as a literal `%3Frange=1D` — a
    /// 404 whose cause is invisible in the request line.
    var query: [String: String] = [:]
    var body: Data?
    /// What the caller can render. Everything under `/api/mobile/v1` answers
    /// JSON except the brand-icon proxy, which answers image bytes.
    var accept: String = "application/json"
    /// Cookies to echo back. Used only by the passkey ceremony, which is
    /// cookie-bound on the server side; see `AuthClient`.
    var cookies: [String: String] = [:]
    /// The signed session token, when the call needs one.
    var bearerToken: String?
}

struct APIResponse: Sendable {
    let status: Int
    let body: Data
    /// Cookies the server set, as name → value. Kept as strings rather than
    /// `HTTPCookie` so the whole type stays `Sendable` and testable.
    let cookies: [String: String]
    /// The `set-auth-token` header, present only on responses that establish a
    /// session and only for a caller that declared itself native.
    let sessionToken: String?

    var isSuccess: Bool { (200..<300).contains(status) }
}

/// The single door to the server.
///
/// Two policies are enforced here rather than trusted to callers:
///
///   - **the native-client header goes on every request**, including the ones
///     made before a session exists. Without it Better Auth's `set-auth-token`
///     is stripped from the response and sign-in silently produces nothing to
///     store (src/lib/api/mobile/native-client.ts);
///   - **cookies are never stored**. `URLSession` would happily keep the
///     session cookie in `HTTPCookieStorage`, which is exactly the hidden state
///     plan A.6.4 rejects: the app could not see it, clear it on sign-out, or
///     reason about it. The one cookie this client handles — the passkey
///     challenge — is passed explicitly between two calls and then forgotten.
struct APIClient: Sendable {
    /// The one seam. Real builds get `URLSession`; tests get a closure that
    /// inspects the request and answers whatever the case needs.
    ///
    /// A closure rather than a `URLProtocol` stub on purpose: `URLProtocol`
    /// moves `httpBody` into a stream and lives in global mutable state, which
    /// makes exactly the two things worth asserting — the body and the headers
    /// of a specific call — awkward and non-parallelisable.
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    let config: AppConfig
    private let transport: Transport

    init(config: AppConfig, transport: Transport? = nil) {
        self.config = config
        if let transport {
            self.transport = transport
        } else {
            self.transport = { try await APIClient.shared.data(for: $0) }
        }
    }

    /// ONE session for the whole process.
    ///
    /// There are eighteen places that build an `APIClient`, several of them
    /// inside a `navigationDestination` closure that SwiftUI re-evaluates —
    /// so a session per client meant a fresh connection pool, and therefore a
    /// fresh TLS handshake, for practically every screen. On a desk that is
    /// invisible; on cellular it is a visible second before anything paints.
    /// Sharing one session lets HTTP/2 reuse the connection the last screen
    /// already opened.
    ///
    /// Nothing here is per-request state — the bearer token, cookies and
    /// Origin all live on the `URLRequest` — so there is nothing for two
    /// callers to collide over.
    static let shared: URLSession = makeSession()

    static func makeSession() -> URLSession {
        // Ephemeral, and deliberately still ephemeral now that the process
        // shares one: it means no response of ours is ever written to a
        // URL cache, which is what keeps a `Cache-Control` header the server
        // did not think hard about from ever serving stale money. Brand icons
        // want the opposite and get it explicitly, on their own terms, in
        // `RemoteImageCache`.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        // A cold Vercel function can take a second or two (plan A.7); a phone
        // on a bad connection should still give up in a human amount of time.
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration)
    }

    /// Base + path + query, with the encoding rules each part actually needs.
    ///
    /// Static and internal so a test can assert on the URL without a round
    /// trip — the encoding of a symbol like `BRK.B` in a path segment is
    /// exactly the kind of thing that works until the one ticker that breaks it.
    /// Query items are sorted so two identical requests produce one string.
    static func url(base: URL, path: String, query: [String: String]) -> URL {
        let withPath = base.appending(path: path)
        guard !query.isEmpty else { return withPath }

        var components = URLComponents(url: withPath, resolvingAgainstBaseURL: false)
        components?.queryItems = query
            .sorted { $0.key < $1.key }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        return components?.url ?? withPath
    }

    func send(_ request: APIRequest) async throws -> APIResponse {
        let url = APIClient.url(base: config.baseURL, path: request.path, query: request.query)
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body

        urlRequest.setValue(NativeClient.value, forHTTPHeaderField: NativeClient.header)
        urlRequest.setValue(request.accept, forHTTPHeaderField: "Accept")
        if request.body != nil {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token = request.bearerToken {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if !request.cookies.isEmpty {
            urlRequest.setValue(Cookies.header(from: request.cookies), forHTTPHeaderField: "Cookie")
        }
        // `/api/mobile/v1/*` refuses an unsafe method whose Origin is not this
        // app's own (src/lib/api/mobile/respond.ts). URLSession sends no Origin
        // at all, so send the right one rather than rely on the bearer-only
        // exemption — the exemption is a fallback, not a licence.
        if !["GET", "HEAD"].contains(request.method) {
            urlRequest.setValue(config.origin, forHTTPHeaderField: "Origin")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(urlRequest)
        } catch {
            throw APIError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(URLError(.badServerResponse))
        }

        return APIResponse(
            status: http.statusCode,
            body: data,
            cookies: Cookies.parse(from: http, url: url),
            sessionToken: http.value(forHTTPHeaderField: "set-auth-token")
        )
    }

    /// Send, insist on 2xx, and decode. The failure path reads Better Auth's
    /// `{ message, code }` body so a log carries the server's own words instead
    /// of a bare status number.
    func decode<T: Decodable>(_ type: T.Type, from request: APIRequest) async throws -> T {
        let response = try await send(request)
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: ErrorBody.message(in: response.body))
        }
        do {
            return try JSONDecoder().decode(T.self, from: response.body)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Send and insist on 2xx, without decoding. For the one route that
    /// answers bytes rather than JSON — the brand-icon proxy. A 404 there is
    /// ordinary ("no logo for this ticker") and is thrown like any other
    /// status, so the caller can remember it and stop asking.
    func bytes(from request: APIRequest) async throws -> Data {
        let response = try await send(request)
        guard response.isSuccess else {
            throw APIError.http(status: response.status, message: nil)
        }
        return response.body
    }
}

/// How this client tells the server it is not a browser. Mirrors
/// `src/lib/api/mobile/native-client.ts`; the two must agree, and the server
/// side is the one with the reasoning written down.
enum NativeClient {
    static let header = "x-stockhodl-client"
    static let value = "ios"
}

/// Cookie handling, factored out because it is the one piece of this file with
/// a genuine edge case worth testing on its own.
enum Cookies {
    /// `HTTPURLResponse` joins repeated `Set-Cookie` headers into one string,
    /// which is ambiguous the moment a cookie carries an `Expires=Wed, 21 Oct`
    /// date. `HTTPCookie.cookies(withResponseHeaderFields:for:)` is Foundation's
    /// own un-joiner for exactly that; hand-splitting on "," is the classic way
    /// to lose a cookie here.
    static func parse(from response: HTTPURLResponse, url: URL) -> [String: String] {
        guard let fields = response.allHeaderFields as? [String: String] else { return [:] }
        let parsed = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
        return Dictionary(parsed.map { ($0.name, $0.value) }, uniquingKeysWith: { _, last in last })
    }

    /// Sorted so the header is deterministic — a test can assert on it, and two
    /// runs of the same ceremony look the same in a proxy log.
    static func header(from cookies: [String: String]) -> String {
        cookies
            .sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: "; ")
    }
}

/// Better Auth answers errors as `{ "message": ..., "code": ... }`. Best effort:
/// a body that does not parse is not itself an error worth reporting, because
/// the status code already said what happened.
enum ErrorBody {
    /// TWO vocabularies, because there are two servers behind one base URL:
    /// Better Auth answers `{ message, code }`, and our own `/api/mobile/v1`
    /// handlers answer `{ error }` (`jsonError` in
    /// `src/lib/api/mobile/respond.ts`). Reading only the first meant every
    /// refusal our routes wrote by hand — "this is your only passkey" — was
    /// discarded on arrival and replaced by a generic sentence.
    private struct Shape: Decodable {
        let message: String?
        let error: String?
        let code: String?
    }

    static func message(in data: Data) -> String? {
        guard let shape = try? JSONDecoder().decode(Shape.self, from: data) else { return nil }
        return shape.message ?? shape.error ?? shape.code
    }
}
