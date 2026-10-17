import SwiftUI

/// The Dashboard's "Day reports" list — one row per day, newest first, with an
/// "Open" (morning brief) and a "Close" (close report) link per half that
/// exists, each a push to the SAME `Route.dayReport` the notification tap
/// reaches, so a past day is one tap away rather than gone with its
/// notification. The figure is the close report's own move, a dash without one.
///
/// Every string on a row arrives formatted from the server (the figure is
/// the one the report stored when it was written); this view only lays them
/// out. A row with no stored figure shows a dash, never a zero.
struct DayReportHistorySection: View {
    let store: DayReportHistoryStore

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Day reports")
                    .font(.system(.subheadline, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
                Spacer()
                // Always reachable, even before any report has been written:
                // the list only shows FINISHED reports, and opening the
                // screen is what asks the server to write today's.
                NavigationLink(value: Self.todayRoute) {
                    Text("Today")
                        .font(.subheadline)
                        .foregroundStyle(Color(Tokens.accent))
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open today's report")
            }

            if store.isLoading, store.items.isEmpty {
                DayReportHistorySkeleton()
            } else if let message = store.errorMessage, store.items.isEmpty {
                LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                    Task { await store.load() }
                }
            } else if store.items.isEmpty {
                EmptyState(
                    title: "No day reports yet",
                    explanation: "Tap Today to read this session's report; the next one is written before the US open.",
                    showsStill: false
                )
                .padding(.vertical, 12)
            } else {
                list
            }
        }
        .padding(.top, 12)
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(store.days) { day in
                DayReportHistoryRow(day: day)
                Divider().overlay(Color(Tokens.surface1))
            }

            if store.nextCursor != nil {
                HStack(spacing: 8) {
                    Button("Show more") {
                        Task { await store.loadMore() }
                    }
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.accent))
                    .disabled(store.isLoadingMore)
                    if store.isLoadingMore {
                        ProgressView().tint(Color(Tokens.textMuted))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }

            StaleCaption(freshness: store.freshness)
                .padding(.top, 4)
        }
    }

    // MARK: - Pure helpers (pinned by DayReportHistoryViewTests)

    /// The SAME route value `stockhodl://day-report/<day>?kind=…` produces,
    /// so a link opens exactly what the notification would have.
    static func route(for day: DayReportHistoryDay, kind: DayReportKind) -> Route {
        Route.dayReport(day: day.day, kind: kind)
    }

    /// The latest reportable day (nil = the server picks it) opened on its
    /// morning half, which exists from the moment the day begins.
    static let todayRoute = Route.dayReport(day: nil, kind: .morning)

    static func linkTitle(_ kind: DayReportKind) -> String {
        switch kind {
        case .morning: "Open"
        case .close: "Close"
        }
    }

    static func linkAccessibilityLabel(kind: DayReportKind, dayLabel: String) -> String {
        switch kind {
        case .morning: "Open morning brief for \(dayLabel)"
        case .close: "Open close report for \(dayLabel)"
        }
    }

    /// The day's figure comes from the close report only: "—" without one (or
    /// without a stored figure), "At least …" when the close was partial.
    static func changeText(_ day: DayReportHistoryDay) -> String {
        guard let close = day.close, let change = close.dayChange else { return "—" }
        return DayReportView.headline(change.text, partial: close.partial)
    }

    static func rowAccessibilityLabel(_ day: DayReportHistoryDay) -> String {
        var parts = [day.dayLabel, changeText(day)]
        if let pct = day.close?.dayChangePct { parts.append(pct) }
        return parts.joined(separator: ", ")
    }
}

/// One row per day: the day, its "Open" / "Close" links, and the close
/// report's move on the right. The row body is inert; only the links navigate.
/// Dynamic Type reflows it; the FIGURE truncates, never the label.
private struct DayReportHistoryRow: View {
    let day: DayReportHistoryDay

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(day.dayLabel)
                .font(.system(.subheadline, weight: .semibold))
                .foregroundStyle(Color(Tokens.textPrimary))
                .accessibilityLabel(DayReportHistorySection.rowAccessibilityLabel(day))
            HStack(spacing: 4) {
                if day.morning != nil { link(.morning) }
                if day.close != nil { link(.close) }
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                Text(DayReportHistorySection.changeText(day))
                    .monospacedDigit()
                    .lineLimit(1)
                    .foregroundStyle(Color(figureToken))
                if let pct = day.close?.dayChangePct {
                    Text("(\(pct))")
                        .monospacedDigit()
                        .lineLimit(1)
                        .foregroundStyle(Color(figureToken))
                }
            }
            .font(.subheadline)
            .accessibilityHidden(true)
        }
        .padding(.vertical, 6)
    }

    private var figureToken: DesignToken {
        day.close?.dayChange?.direction.token ?? Tokens.textMuted
    }

    private func link(_ kind: DayReportKind) -> some View {
        NavigationLink(value: DayReportHistorySection.route(for: day, kind: kind)) {
            Text(DayReportHistorySection.linkTitle(kind))
                .font(.subheadline)
                .foregroundStyle(Color(Tokens.accent))
        }
        .buttonStyle(.plain)
        .quietHitRegion()
        .accessibilityLabel(
            DayReportHistorySection.linkAccessibilityLabel(kind: kind, dayLabel: day.dayLabel)
        )
    }
}

/// Holds the list's place while page one is in flight — three pulsing
/// placeholder rows, the `OptionsSectionSkeleton` idiom.
private struct DayReportHistorySkeleton: View {
    @State private var pulse = false

    var body: some View {
        VStack(spacing: 8) {
            ForEach(0..<3, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(Tokens.surface1))
                    .frame(height: 44)
                    .opacity(pulse ? 0.5 : 1)
            }
        }
        .padding(.top, 8)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}
