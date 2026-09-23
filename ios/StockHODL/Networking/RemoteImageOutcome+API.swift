import Foundation

extension RemoteImageOutcome {
    /// Turn a throwing bytes call into an outcome, in ONE place.
    ///
    /// The distinction is easy to get subtly wrong at a call site and its
    /// consequence is invisible until a logo has been missing for an hour, so
    /// no call site is allowed to make it: a 404 is the server saying the
    /// picture does not exist, and every other error — transport, timeout,
    /// cancellation, a 500 — established nothing at all.
    static func of(_ load: () async throws -> Data) async -> RemoteImageOutcome {
        do {
            return .bytes(try await load())
        } catch APIError.http(status: 404, message: _) {
            return .absent
        } catch {
            return .failed
        }
    }
}
