import Foundation

/// The screenshot importers — the one call in this app that spends money.
///
/// Each request is a paid vision read, which is why the client downscales and
/// size-checks BEFORE sending (`ScreenshotImage`): the server re-checks
/// everything and its checks are the control, but a request refused there has
/// already cost a round trip on a phone connection and, if it passed the free
/// gates, part of a shared ten-minute budget.
///
/// Neither call writes anything. The transaction importer answers a PREFILL —
/// the server-side decisions about side, currency and fees — and the option
/// importer answers the raw extraction plus a separate, free contract match.
/// The write is the ordinary form's, on both surfaces.
struct ImportClient: Sendable {
    let api: APIClient

    func transaction(
        imageBase64: String,
        token: String
    ) async throws -> TransactionImportResponse {
        try await api.decode(
            TransactionImportResponse.self,
            from: request(path: "/api/mobile/v1/import/transaction", imageBase64: imageBase64, token: token)
        )
    }

    func option(imageBase64: String, token: String) async throws -> OptionImportResponse {
        try await api.decode(
            OptionImportResponse.self,
            from: request(path: "/api/mobile/v1/import/option", imageBase64: imageBase64, token: token)
        )
    }

    private func request(path: String, imageBase64: String, token: String) -> APIRequest {
        APIRequest(
            method: "POST",
            path: path,
            body: try? JSONEncoder().encode(ScreenshotImportRequestBody(imageBase64: imageBase64)),
            bearerToken: token
        )
    }
}

/// Hand-written, like every other request body: the generated types are
/// response shapes, and this one is a single field.
struct ScreenshotImportRequestBody: Encodable, Sendable {
    let imageBase64: String
}
