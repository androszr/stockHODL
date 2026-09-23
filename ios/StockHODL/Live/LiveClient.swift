import Foundation

/// The Holdings data layer: one cold-start call, one refresh call, one stream.
///
/// Every path here is bearer-authenticated and lives under `/api/mobile/v1/`.
/// That prefix is not cosmetic — `src/proxy.ts` is a cookie gate whose
/// exclusion list is that prefix plus auth, cron and the Associated Domains
/// file, so a bearer-only client that missed it would get an empty 404
/// instead of JSON. The handlers compose the payload from the shared
/// server functions.
struct LiveClient: Sendable {
    let api: APIClient

    /// Cold start: portfolios, the static half of every holding, the watchlist
    /// and the live payload, in ONE round trip. On a phone the round trip
    /// dominates, and the halves are useless apart — a card cannot paint
    /// without both.
    func bootstrap(token: String) async throws -> BootstrapResponse {
        try await api.decode(
            BootstrapResponse.self,
            from: APIRequest(path: "/api/mobile/v1/bootstrap", bearerToken: token)
        )
    }

    /// The refresh: prices only. Called on the cadence `PollPolicy` allows, and
    /// once whenever the app returns to the foreground.
    func live(token: String) async throws -> LivePayload {
        try await api.decode(
            LivePayload.self,
            from: APIRequest(path: "/api/mobile/v1/live", bearerToken: token)
        )
    }
}

// MARK: - Server-sent events

/// One event off the wire, already matched to what the server sends.
///
/// The four cases are the four `sse(...)` calls in
/// `src/lib/holdings/stream-response.ts`. Naming them here rather than passing
/// raw strings around means a renamed event breaks a switch at compile time
/// instead of silently becoming a no-op at runtime.
///
/// Generic over the payload because `quoteStreamResponse` composes TWO of them
/// — holdings and watchlist — over one identical lifecycle. Two copies of this
/// parser is how the watchlist would eventually stop reconnecting for a reason
/// nobody could find.
///
/// Not `Equatable`: the generated contracts are `Codable, Sendable` and nothing
/// more, because they mirror a wire format rather than a domain model. Tests
/// pattern-match on the case instead, which is what they actually care about.
enum StreamEvent<Payload: Decodable & Sendable>: Sendable {
    /// A recomposed payload. The only event that carries data worth painting.
    case payload(Payload)
    /// The market is closed or there is structurally nothing to stream. Carries
    /// when polling may resume; until then the client must go quiet.
    case idle(resumesAtMs: Int?)
    /// The vendor socket failed in a way that leaves polling viable — fall back
    /// to the REST cadence rather than treating it as an outage.
    case fallback(reason: String?)
    /// A clean end. `lifetime` is the ordinary one: Vercel caps the function,
    /// so the stream ending is normal and means reconnect, not error.
    case bye(reason: String?)
}

/// Reads an SSE body into typed events.
///
/// Written as a parser over lines rather than a callback API so it can be
/// tested against a literal string — the reconnect logic above it is the part
/// most likely to be wrong, and it deserves a test that does not need a server.
typealias LiveEvent = StreamEvent<LivePayload>

struct SSEParser<Payload: Decodable & Sendable> {
    private var event: String?
    private var data = ""

    /// Feeds one line. Returns an event when the blank line that terminates a
    /// frame arrives, `nil` otherwise. Comment lines (`: ping`) are ignored,
    /// which is exactly their purpose — they keep intermediaries from reaping
    /// an idle stream and mean nothing to us.
    mutating func consume(line: String) -> StreamEvent<Payload>? {
        if line.isEmpty {
            defer {
                event = nil
                data = ""
            }
            return finish()
        }
        if line.hasPrefix(":") { return nil }

        if let value = value(of: "event:", in: line) {
            event = value
        } else if let value = value(of: "data:", in: line) {
            // Multi-line data fields concatenate with a newline, per the spec.
            data += data.isEmpty ? value : "\n" + value
        }
        return nil
    }

    private func value(of field: String, in line: String) -> String? {
        guard line.hasPrefix(field) else { return nil }
        // Exactly one optional leading space is stripped, per the spec — not
        // arbitrary whitespace, which would corrupt a payload starting with one.
        var rest = line.dropFirst(field.count)
        if rest.hasPrefix(" ") { rest = rest.dropFirst() }
        return String(rest)
    }

    private func finish() -> StreamEvent<Payload>? {
        guard let event, !data.isEmpty, let bytes = data.data(using: .utf8) else { return nil }

        switch event {
        case "payload":
            return (try? JSONDecoder().decode(Payload.self, from: bytes)).map(StreamEvent.payload)
        case "idle":
            return .idle(resumesAtMs: try? JSONDecoder().decode(Resumes.self, from: bytes).pollingResumesAtMs)
        case "fallback":
            return .fallback(reason: try? JSONDecoder().decode(Reason.self, from: bytes).reason)
        case "bye":
            return .bye(reason: try? JSONDecoder().decode(Reason.self, from: bytes).reason)
        default:
            // An event this build does not know about is not an error — the
            // server may learn to send more than this client reads.
            return nil
        }
    }

    private struct Resumes: Decodable { let pollingResumesAtMs: Int? }
    private struct Reason: Decodable { let reason: String? }
}

extension APIClient {
    /// A server-sent-event stream, as an async sequence of typed events.
    ///
    /// `URLSession.bytes(for:)` rather than a third-party EventSource: the
    /// protocol is a dozen lines, and a dependency here would own the one part
    /// of the app that must cooperate with `scenePhase` and the Keychain.
    ///
    /// The sequence ENDS rather than throwing when the server closes cleanly.
    /// That is the common case on Vercel — a capped function lifetime — and the
    /// caller reconnects.
    func events<Payload: Decodable & Sendable>(
        path: String,
        token: String
    ) -> AsyncThrowingStream<StreamEvent<Payload>, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: config.baseURL.appending(path: path))
                    request.setValue(NativeClient.value, forHTTPHeaderField: NativeClient.header)
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    // A stream has no business timing out on idleness; the
                    // server's own ping and lifetime cap bound it instead —
                    // except when the connection dies WITHOUT telling anyone.
                    // See `StreamWatchdog` below for that half.
                    request.timeoutInterval = .infinity

                    // The process-wide session, not one per reconnect: a
                    // capped Vercel stream ends every few minutes, and a
                    // fresh session each time threw away the connection it
                    // could have reused.
                    let (bytes, response) = try await APIClient.shared.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                        throw APIError.http(status: status, message: nil)
                    }

                    // An interface handoff (Wi-Fi ↔ cellular) or a NAT mapping
                    // that expires can drop the underlying TCP path without a
                    // RST — nothing throws, `bytes.lines` just never produces
                    // another element, and the pump sits there forever showing
                    // stale prices. The server pings every 15 s
                    // (`stream-response.ts`), so 35 s of total silence is
                    // already more than double a missed ping; past that the
                    // watchdog cuts the request loose so the loop below fails
                    // instead of hanging, and `LiveStore.runPump` reconnects
                    // the same way it does for any other stream failure.
                    let watchdog = StreamWatchdog()
                    let watchdogTask = Task {
                        await watchdog.run(timeout: .seconds(35)) { bytes.task.cancel() }
                    }
                    defer { watchdogTask.cancel() }

                    var parser = SSEParser<Payload>()
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        await watchdog.touch()
                        if let event = parser.consume(line: line) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Detects an SSE stream that stopped delivering bytes without ever throwing.
///
/// An actor because `touch()` is called from the reading loop and `run()`
/// polls from its own task; both must serialize on the same deadline, and a
/// plain class here would need its own lock to be safe under Swift 6
/// concurrency checking.
private actor StreamWatchdog {
    private var lastActivity = ContinuousClock.now

    /// Called on every line read, including SSE comment pings — any byte at
    /// all is proof the connection is still alive.
    func touch() {
        lastActivity = .now
    }

    /// Polls once a second rather than sleeping for the whole timeout: a
    /// `touch()` mid-sleep must push the deadline out immediately, not be
    /// read stale after a long nap. The reading task's `defer` cancels the
    /// `Task` this runs in on every exit path — clean end, thrown error, or
    /// outer cancellation — which is what stops the loop below; there is no
    /// separate stop signal to forget to call.
    func run(timeout: Duration, onStale: @Sendable () -> Void) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            if Task.isCancelled { return }
            if ContinuousClock.now - lastActivity > timeout {
                onStale()
                return
            }
        }
    }
}

extension LiveClient {
    /// The holdings stream.
    func stream(token: String) -> AsyncThrowingStream<LiveEvent, Error> {
        api.events(path: "/api/mobile/v1/live/stream", token: token)
    }
}
