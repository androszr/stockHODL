import SwiftUI

/// Instants that appear beside a figure. pl-PL like every other formatted
/// time in the app, and device-local — the phone's own clock is the honest
/// reading of a moment, which is exactly why the web formats these in the
/// browser rather than on Vercel.
enum Instants {
    /// `TimeInterval`, not `Double`: a moment in time is the one quantity in
    /// this app that is legitimately floating point. Money never is.
    private static func date(_ ms: Int) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    /// `pt., 22:00` — the extended-hours suffix.
    static func weekdayTime(_ ms: Int) -> String {
        date(ms).formatted(
            .dateTime.weekday(.abbreviated)
                .hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
                .locale(ChartLabels.locale)
        )
    }

    /// `14:32` — the cached-price suffix.
    static func clock(_ ms: Int) -> String {
        ChartLabels.hourMinute(ms)
    }
}

/// The ONE renderer of the extended-hours line — holdings card, watch tile and
/// the instrument header all use THIS, so the session wording, the direction
/// colouring and the stale-reading timestamp can never drift apart. Same role
/// as `src/components/holdings/extended-move.tsx`, and the wording is taken
/// from it verbatim.
///
/// The session word carries which session it is and the sign in the text
/// carries the direction — colour is a bonus on both, never the signal. When
/// the reading comes from a session that has ENDED (`live == false` — its own
/// fact, never inferred from a missing instant), the WHOLE line dims and the
/// accessible label says "closed session" in words, because dimming must
/// never be the only signal.
struct ExtendedMoveView: View {
    enum Variant {
        /// Cards and headers: session word, figure, and the instant when the
        /// reading is stale.
        case full
        /// Tiles: the short word and the figure. NO instant — on a tile the
        /// suffix never fits, and reserving room for something that can never
        /// be shown protects nothing.
        case compact
    }

    let extended: ExtendedFigure
    var variant: Variant = .full

    private var ended: Bool { !extended.live }

    private var word: String {
        switch (variant, extended.kind) {
        case (.full, .early): "Pre-market"
        case (.full, .late): "After hours"
        case (.compact, .early): "Pre"
        case (.compact, .late): "AH"
        }
    }

    private var suffix: String? {
        guard variant == .full, let endedAt = extended.endedAtMs else { return nil }
        return Instants.weekdayTime(endedAt)
    }

    var body: some View {
        HStack(spacing: 4) {
            Text(word)
                .foregroundStyle(Color(ended ? Tokens.textMuted : Tokens.textSecondary))
            Text(extended.text)
                .monospacedDigit()
                .foregroundStyle(Color(ended ? Tokens.textMuted : extended.direction.token))
            if let suffix {
                Text("· \(suffix)")
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .font(variant == .full ? .caption : .caption2)
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    private var spoken: String {
        let base = "\(word) \(extended.text)"
        let closed = ended ? ", closed session" : ""
        let when = suffix.map { ", \($0)" } ?? ""
        return base + closed + when
    }
}

/// The "cached · 14:32" label beside a fallback price. The word plus the
/// instant claims exactly what is true — this price is the last one we saved,
/// and here is when. Disclosure is text, never colour alone.
struct CachedAsOfLabel: View {
    let asOfMs: Int

    var body: some View {
        Text("cached · \(Instants.clock(asOfMs))")
            .font(.caption2)
            .monospacedDigit()
            .foregroundStyle(Color(Tokens.textMuted))
    }
}
