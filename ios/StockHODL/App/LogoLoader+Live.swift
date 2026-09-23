import Foundation

/// Production wiring for the brand-icon tiles — same split as every other
/// `+Live` file: the store knows how to fetch, this knows where from.
extension LogoLoader {
    @MainActor
    static func live(auth: AuthStore, config: AppConfig = .current) -> LogoLoader {
        let api = APIClient(config: config)
        return LogoLoader { symbol in
            // The token is read at REQUEST time, on the main actor. Capturing
            // it once at construction would leave a logo loader holding a
            // revoked token for the rest of the process.
            guard let token = await MainActor.run(body: { auth.sessionToken }) else { return .failed }
            return await RemoteImageOutcome.of {
                try await api.bytes(
                    from: APIRequest(
                        path: "/api/mobile/v1/logo/\(symbol)",
                        accept: "image/*",
                        bearerToken: token
                    )
                )
            }
        }
    }
}
