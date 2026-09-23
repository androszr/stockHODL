import Foundation
import Testing

@testable import StockHODL

/// Records what the client actually put on the wire.
///
/// A class rather than a captured local because the closure must be `@Sendable`
/// while the test needs to read the result afterwards. The lock is not
/// ceremony: `URLSession`'s real transport is concurrent, and a double that
/// pretends otherwise hides a data race instead of preventing one.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var last: URLRequest? {
        lock.withLock { requests.last }
    }

    var count: Int {
        lock.withLock { requests.count }
    }

    func record(_ request: URLRequest) {
        lock.withLock { requests.append(request) }
    }
}

private let config = AppConfig(baseURL: URL(string: "https://sawa-finance.vercel.app")!)

private func makeClient(
    status: Int = 200,
    headers: [String: String] = [:],
    body: Data = Data("{}".utf8),
    recorder: Recorder
) -> APIClient {
    APIClient(config: config) { request in
        recorder.record(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        return (body, response)
    }
}

@Suite("APIClient")
struct APIClientTests {
    // MARK: - Headers

    @Test("declares itself native on every request, authenticated or not")
    func alwaysNative() async throws {
        let recorder = Recorder()
        let client = makeClient(recorder: recorder)

        _ = try await client.send(APIRequest(path: "/api/auth/passkey/generate-authenticate-options"))

        let request = try #require(recorder.last)
        // This is the header the sign-in flow cannot work without: strip it and
        // the server withholds `set-auth-token`, leaving nothing to store. It
        // has to be present BEFORE a session exists, which is why it is not
        // conditional on the bearer token.
        #expect(request.value(forHTTPHeaderField: "x-stockhodl-client") == "ios")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("sends the bearer token when it has one")
    func bearer() async throws {
        let recorder = Recorder()
        let client = makeClient(recorder: recorder)

        _ = try await client.send(APIRequest(path: "/api/auth/get-session", bearerToken: "sig.ned"))

        #expect(recorder.last?.value(forHTTPHeaderField: "Authorization") == "Bearer sig.ned")
    }

    @Test("claims an Origin on a write, and none on a read")
    func origin() async throws {
        let recorder = Recorder()
        let client = makeClient(recorder: recorder)

        _ = try await client.send(APIRequest(path: "/api/mobile/v1/bootstrap"))
        #expect(recorder.last?.value(forHTTPHeaderField: "Origin") == nil)

        _ = try await client.send(APIRequest(method: "POST", path: "/api/mobile/v1/transactions"))
        // Must match `new URL(BETTER_AUTH_URL).origin` exactly — the server's
        // CSRF check is string equality, so a trailing slash is a 401 with
        // nothing in the response to explain it.
        #expect(recorder.last?.value(forHTTPHeaderField: "Origin") == "https://sawa-finance.vercel.app")
    }

    @Test("builds an origin without a trailing slash even from a sloppy base URL")
    func originNormalises() {
        let sloppy = AppConfig(baseURL: URL(string: "https://sawa-finance.vercel.app/")!)
        #expect(sloppy.origin == "https://sawa-finance.vercel.app")

        let local = AppConfig(baseURL: URL(string: "http://localhost:3000")!)
        #expect(local.origin == "http://localhost:3000")
        #expect(local.relyingPartyID == "localhost")
    }

    @Test("sets a JSON content type only when there is a body")
    func contentType() async throws {
        let recorder = Recorder()
        let client = makeClient(recorder: recorder)

        _ = try await client.send(APIRequest(path: "/api/auth/get-session"))
        #expect(recorder.last?.value(forHTTPHeaderField: "Content-Type") == nil)

        _ = try await client.send(APIRequest(
            method: "POST",
            path: "/api/auth/sign-out",
            body: Data("{}".utf8)
        ))
        #expect(recorder.last?.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    // MARK: - Cookies

    @Test("sends supplied cookies in one deterministic header")
    func cookieHeader() async throws {
        let recorder = Recorder()
        let client = makeClient(recorder: recorder)

        _ = try await client.send(APIRequest(
            method: "POST",
            path: "/api/auth/passkey/verify-authentication",
            cookies: ["z-last": "2", "a-first": "1"]
        ))

        #expect(recorder.last?.value(forHTTPHeaderField: "Cookie") == "a-first=1; z-last=2")
    }

    @Test("reads back a Set-Cookie that carries a comma inside its Expires date")
    func cookieParsing() async throws {
        let recorder = Recorder()
        // The trap this guards: `HTTPURLResponse` joins repeated Set-Cookie
        // headers with ", " and an Expires date contains ", " of its own, so
        // splitting on commas loses the challenge cookie — and the ceremony
        // then fails with "challenge not found", which reads like an expiry.
        let client = makeClient(
            headers: [
                "Set-Cookie":
                    "better-auth-passkey=abc123; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly",
            ],
            recorder: recorder
        )

        let response = try await client.send(APIRequest(path: "/api/auth/passkey/generate-authenticate-options"))

        #expect(response.cookies["better-auth-passkey"] == "abc123")
    }

    // MARK: - Responses

    @Test("surfaces the session token the phone must store")
    func sessionToken() async throws {
        let recorder = Recorder()
        let client = makeClient(headers: ["set-auth-token": "payload.signature"], recorder: recorder)

        let response = try await client.send(APIRequest(path: "/api/auth/passkey/verify-authentication"))

        #expect(response.sessionToken == "payload.signature")
    }

    @Test("reports the server's own words on a failure")
    func errorMessage() async throws {
        let recorder = Recorder()
        let client = makeClient(
            status: 400,
            body: Data(#"{"code":"CHALLENGE_NOT_FOUND","message":"Challenge not found"}"#.utf8),
            recorder: recorder
        )

        await #expect(throws: APIError.self) {
            _ = try await client.decode(SessionEnvelope.self, from: APIRequest(path: "/api/auth/get-session"))
        }

        do {
            _ = try await client.decode(SessionEnvelope.self, from: APIRequest(path: "/api/auth/get-session"))
            Issue.record("expected a failure")
        } catch let APIError.http(status, message) {
            #expect(status == 400)
            #expect(message == "Challenge not found")
        }
    }

    @Test("a transport failure stays a transport failure")
    func transportFailure() async {
        let client = APIClient(config: config) { _ in
            throw URLError(.notConnectedToInternet)
        }

        do {
            _ = try await client.send(APIRequest(path: "/api/auth/get-session"))
            Issue.record("expected a failure")
        } catch let APIError.transport(underlying) {
            #expect((underlying as? URLError)?.code == .notConnectedToInternet)
        } catch {
            Issue.record("wrong error: \(error)")
        }
    }
}
