import SwiftUI

struct NarrativeSection: View {
    let narrative: DayReportNarrative

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Written report").font(.headline)
            if let sentence = Self.stateSentence(narrative.status) {
                Text(sentence).foregroundStyle(Color(Tokens.textMuted))
            } else {
                block("Your portfolio", narrative.portfolioNarrative)
                block("Events", narrative.eventsNarrative)
                block("Macro", narrative.macroNarrative)
                ForEach(narrative.sources, id: \.url) { source in
                    if let url = Self.sourceURL(source.url) {
                        Link(source.title, destination: url)
                            .font(.footnote)
                            .foregroundStyle(Color(Tokens.accent))
                    }
                }
            }
            if narrative.staleFigures {
                Text("Written from earlier figures — the numbers above have changed since")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .padding(16)
        .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private func block(_ title: String, _ text: String?) -> some View {
        if let text, !text.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(text).font(.subheadline).foregroundStyle(Color(Tokens.textSecondary))
            }
        }
    }

    static func stateSentence(_ status: DayReportNarrativeStatus) -> String? {
        switch status {
        case .pending: "Writing…"
        case .refused, .unavailable, .notConfigured: "No narrative for this day"
        case .ready: nil
        }
    }

    static func sourceURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), url.scheme == "https" else { return nil }
        return url
    }
}
