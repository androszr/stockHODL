import SwiftUI

/// Market state word plus a per-second countdown to the next session
/// boundary — `src/components/holdings/market-status-bar.tsx`, natively.
///
/// The client does NO timezone math. It counts down to a server-computed
/// epoch ms, which is what keeps the display honest in the weeks when the US
/// and EU change clocks on different weekends.
///
/// It replaced a one-line caption that said "Market closed · resumes 15:30".
/// The caption was true and nearly invisible; on the web this is the element
/// that tells you whether the numbers below are moving at all, and a phone
/// needs that answer more than a browser does, not less.
struct MarketStatusBar: View {
    let market: LiveMarket

    var body: some View {
        HStack(spacing: 8) {
            // Decorative — the adjacent word is the signal. Colour alone
            // never carries a state in this app.
            Circle()
                .fill(Color(market.status == .marketStatusOpen ? Tokens.gain : Tokens.neutral))
                .frame(width: 8, height: 8)

            Text(MarketStatusBar.word(for: market.status))
                .font(.system(.subheadline, weight: .medium))
                .foregroundStyle(Color(Tokens.textPrimary))

            if let target = market.nextTransitionAtMs, let kind = market.nextTransitionKind {
                // A ticking clock, so a closed market reads as waiting rather
                // than as a screen that stopped updating.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("\(MarketStatusBar.verb(kind)) \(MarketStatusBar.remaining(until: target, now: context.date))")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(Tokens.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
        // Outside the fill — the web bar's `mt-4`. Without it the box
        // sits flush under the top bar on Dashboard and Options.
        .padding(.top, 16)
    }

    /// The word always carries the state — the dot's colour is never alone.
    static func word(for status: MarketStatus) -> String {
        switch status {
        case .marketStatusOpen: "Open"
        case .earlyTrading: "Pre-market"
        case .lateTrading: "After hours"
        case .closed: "Closed"
        case .unknown: "Status unavailable"
        }
    }

    static func verb(_ kind: MarketTransitionKind) -> String {
        kind == .close ? "closes in" : "opens in"
    }

    /// Durations are counts, not money — plain integer math is sanctioned,
    /// and this is a port of `formatRemaining` down to the clamp at zero.
    static func remaining(until targetMs: Int, now: Date) -> String {
        let nowMs = Int(now.timeIntervalSince1970 * 1000)
        let total = max(0, (targetMs - nowMs) / 1000)
        let days = total / 86_400
        let hours = (total % 86_400) / 3_600
        let minutes = (total % 3_600) / 60
        let seconds = total % 60
        let clock = String(format: "%d:%02d:%02d", hours, minutes, seconds)
        return days > 0 ? "\(days)d \(clock)" : clock
    }
}
