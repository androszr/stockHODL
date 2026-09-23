import SwiftUI

/// Company facts under the day stats: description, market cap, employees,
/// website, and the 52-week range bar.
///
/// Every figure arrives pre-formatted. The only number this view computes
/// is the marker's position on the bar, and that goes through
/// `PlotPoints.rangeFraction` — the allowlisted geometry crossing.
struct AboutPanel: View {
    let about: About?
    let currency: String

    /// 180 characters is a deterministic stand-in for "more than three
    /// lines" on a phone-width caption — measuring wrapped height needs a
    /// laid-out view, which a unit test cannot see.
    private static let descriptionCollapseAt = 180

    @State private var descriptionExpanded = false

    var body: some View {
        if let about, !isVacant(about) {
            Panel(title: "About") {
                if let description = about.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textSecondary))
                        .lineLimit(descriptionExpanded ? nil : 3)

                    if description.count > Self.descriptionCollapseAt {
                        Button(descriptionExpanded ? "Less" : "More") {
                            descriptionExpanded.toggle()
                        }
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.accent))
                        .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                }

                FigureRow(
                    label: "Market cap (\(currency))",
                    value: about.marketCap ?? "—"
                )
                FigureRow(label: "Employees", value: about.employees ?? "—")

                if let website = about.website, let url = Self.httpURL(website) {
                    Link(destination: url) {
                        FigureRow(label: "Website", value: url.host ?? website)
                    }
                    .buttonStyle(.plain)
                    .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }

                if let range = about.week52 {
                    Week52Bar(range: range, currency: currency)
                }
            }
        }
    }

    private func isVacant(_ about: About) -> Bool {
        about.description == nil
            && about.marketCap == nil
            && about.employees == nil
            && about.website == nil
            && about.week52 == nil
    }

    /// Second guard on a vendor-controlled string: only http(s) becomes a
    /// tappable link. The server already dropped anything else.
    private static func httpURL(_ string: String) -> URL? {
        guard let url = URL(string: string),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }
}

/// Low label leading, high trailing, marker on the track when the fraction
/// is defined. Position-on-a-bar is invisible to VoiceOver, so the whole
/// control speaks one sentence instead.
private struct Week52Bar: View {
    let range: Week52Range
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("52-week range")
                .font(.caption2)
                .foregroundStyle(Color(Tokens.textMuted))

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color(Tokens.surface2))
                        .frame(height: 6)
                        .frame(maxWidth: .infinity)
                    if let current = range.currentRaw,
                       let fraction = PlotPoints.rangeFraction(
                           low: range.lowRaw,
                           high: range.highRaw,
                           value: current
                       )
                    {
                        Circle()
                            .fill(Color(Tokens.textPrimary))
                            .frame(width: 10, height: 10)
                            .offset(x: (geo.size.width - 10) * CGFloat(fraction))
                    }
                }
            }
            .frame(height: 10)

            HStack {
                Text(range.low)
                Spacer()
                Text(range.high)
            }
            .font(.caption2)
            .monospacedDigit()
            .foregroundStyle(Color(Tokens.textMuted))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySentence)
    }

    private var accessibilitySentence: String {
        // Display-only: `dec` + `fmtMoney` so VoiceOver hears the same
        // pl-PL figure as the labels, never the raw English decimal.
        if let raw = range.currentRaw, let amount = dec(raw) {
            "52-week range \(range.low) to \(range.high), current \(fmtMoney(amount, currency: currency))"
        } else {
            "52-week range \(range.low) to \(range.high)"
        }
    }
}
