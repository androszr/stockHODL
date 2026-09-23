enum DayReportKind: String, Codable, Sendable, CaseIterable {
    case morning
    case close

    var payload: DayReportPayloadKind {
        switch self {
        case .morning: .morning
        case .close: .close
        }
    }

    init(_ payload: DayReportPayloadKind) {
        self = payload == .morning ? .morning : .close
    }
}
