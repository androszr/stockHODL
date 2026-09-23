import SwiftUI

/// The strip that admits the figures underneath it are not current.
///
/// It existed twice — a `private struct StaleBar` in `HoldingsView` saying
/// "Data from 17:02" and an inline `HStack` in `WatchlistView` saying "Figures
/// may be out of date" — with the same icon, the same padding and two
/// different claims about the same situation. Two renderings of one idea drift,
/// and this one drifted before it was a week old.
///
/// One view now, driven by `Freshness`, so the wording is decided in
/// `StaleLabel` (which a test can read) rather than in a `View` body (which
/// one cannot).
struct StaleBar: View {
    let freshness: Freshness

    var body: some View {
        if let label = StaleLabel.label(for: freshness) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                Text(label.text)
            }
            // The warning escalates by WEIGHT, not by hue. There is no
            // `warning` token — `tokens.css` is the only file allowed a colour
            // literal (non-negotiable #2) and inventing one here would be the
            // start of a second palette — and the obvious stand-in, `loss`, is
            // a category error: red on a portfolio screen means the money went
            // down, not that the clock did.
            .font(.caption)
            .fontWeight(label.isWarning ? .semibold : .regular)
            .foregroundStyle(Color(label.isWarning ? Tokens.textSecondary : Tokens.textMuted))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Color(Tokens.surface2))
            // The bar appears and disappears under a list the user may be
            // mid-scroll in. Without this it inserts itself instantly and the
            // rows jump; the animation makes it read as a thing arriving
            // rather than as a layout glitch.
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// A crossed-out radio only when we KNOW the radio is the problem. Saying
    /// it while the server is merely down would be the app blaming the user's
    /// connection for its own outage — the same reason the copy says "Can't
    /// reach the network" rather than "You are offline".
    private var icon: String {
        switch freshness {
        case .disconnected: "wifi.slash"
        case .stale, .fresh: "clock.arrow.circlepath"
        }
    }
}

/// The compact sibling of `StaleBar`, for a row that sits under a bar which
/// already covers the screen.
///
/// Same wording, same source — `StaleLabel`, which answers nil while fresh —
/// but smaller chrome and no background: the Dashboard already carries the
/// holdings' full-width bar, and a second (or third) strip saying the same
/// kind of thing would read as an outage rather than as a note. It lived
/// inline in `MarketIndexStrip` until the options row needed the same line;
/// two copies of one caption is exactly the drift this file's own header
/// records having happened once already.
struct StaleCaption: View {
    let freshness: Freshness

    var body: some View {
        if let label = StaleLabel.label(for: freshness) {
            Text(label.text)
                // 10 pt, deliberately smaller than `.caption`: this is a
                // footnote under a row, not an alarm across the screen.
                // Escalates by WEIGHT, never by hue — see `StaleBar`.
                .font(.system(size: 10))
                .fontWeight(label.isWarning ? .semibold : .regular)
                .foregroundStyle(
                    Color(label.isWarning ? Tokens.textSecondary : Tokens.textMuted)
                )
        }
    }
}

/// The whole-screen version, for a screen that has NOTHING to draw.
///
/// The old error state offered "Try again" unconditionally. Offline that
/// button is a promise the app cannot keep: tapping it fires a request that
/// dies on the same timeout, and the screen returns to exactly where it was.
/// So the offline case says what is actually going to happen — the app is
/// watching for the network and will load by itself — and keeps the button
/// only as a way to hurry it along.
struct LoadFailureView: View {
    let message: String
    let isOffline: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image("BearStill")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 72)
                .accessibilityHidden(true)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color(Tokens.textSecondary))
                .multilineTextAlignment(.center)

            if isOffline {
                Text("This will load as soon as you're back.")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .multilineTextAlignment(.center)
            }

            Button(isOffline ? "Try now" : "Try again", action: retry)
                .foregroundStyle(Color(Tokens.accent))
        }
        .padding(24)
    }
}
