import Foundation

/// One portfolio's target weights — the edit sheet's own door.
///
/// The DRIFT figures do not come through here: they ride inside the analytics
/// payload, already folded on `Decimal` server-side. This client exists only
/// so the sheet can seed its fields from the SERVER rather than from the
/// disk-cached analytics payload, which may be minutes old — a save built on
/// stale seeds would clobber a target set on another device with an older
/// value, and a bulk replace has no way to notice.
///
/// `PortfoliosClient`'s shape: method + path + token, hand-written request
/// structs (the generator deliberately does not emit request bodies — the
/// server schema carries a comma normalisation the client never sends the
/// result of).
struct TargetsClient: Sendable {
    let api: APIClient

    func get(portfolioId: String, token: String) async throws -> TargetsResponse {
        try await api.decode(
            TargetsResponse.self,
            from: APIRequest(
                path: "/api/mobile/v1/portfolios/\(portfolioId)/targets",
                bearerToken: token
            )
        )
    }

    /// A BULK REPLACE: the full row set, never a delta. A blank field is an
    /// omitted row — never `targetPct: "0"`, which the server refuses anyway
    /// because "no target" is an absent row rather than a target of nothing.
    func put(portfolioId: String, rows: [TargetPutRow], token: String) async throws {
        _ = try await api.decode(
            OkResponse.self,
            from: APIRequest(
                method: "PUT",
                path: "/api/mobile/v1/portfolios/\(portfolioId)/targets",
                body: try JSONEncoder().encode(TargetsPutRequest(rows: rows)),
                bearerToken: token
            )
        )
    }
}

/// `portfolioTargetsPutSchema`'s row. The percent is a STRING, normalised
/// the `TransactionInput.swift` way before it gets here.
struct TargetPutRow: Encodable, Sendable, Equatable {
    let instrumentId: String
    let targetPct: String
}

/// `portfolioTargetsPutSchema`.
struct TargetsPutRequest: Encodable, Sendable, Equatable {
    let rows: [TargetPutRow]
}
