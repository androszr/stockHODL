import SwiftUI

/// The Dashboard's "Day reports" list — one row per report the server has
/// written, newest first, each a push to the SAME `Route.dayReport` the
/// notification tap reaches, so a past day is one tap away rather than gone
/// with its notification.
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
            ForEach(store.items, id: \.rowID) { item in
                NavigationLink(value: Self.route(for: item)) {
                    DayReportHistoryRow(item: item)
                }
                .buttonStyle(.plain)
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

    static func kindLabel(_ kind: DayReportPayloadKind) -> String {
        switch kind {
        case .morning: "Morning brief"
        case .close: "Close report"
        }
    }

    /// The SAME route value `stockhodl://day-report/<day>?kind=…` produces,
    /// so the row opens exactly what the notification would have.
    static func route(for item: DayReportHistoryItem) -> Route {
        Route.dayReport(day: item.day, kind: DayReportKind(item.kind))
    }

    /// The latest reportable day (nil = the server picks it) opened on its
    /// morning half, which exists from the moment the day begins.
    static let todayRoute = Route.dayReport(day: nil, kind: .morning)

    /// A morning brief recaps the PREVIOUS session, so its figure is captioned
    /// with the session it describes. Nil when the figure is the row's own
    /// day (a close report) or when there is no figure to caption.
    static func changeCaption(_ item: DayReportHistoryItem) -> String? {
        guard let label = item.figureDayLabel, item.figureDay != item.day else { return nil }
        return "\(label) close"
    }

    /// "—" when the report stored no figure; "At least …" when it was partial.
    static func changeText(_ item: DayReportHistoryItem) -> String {
        guard let change = item.dayChange else { return "—" }
        return DayReportView.headline(change.text, partial: item.partial)
    }
}

/// One row: the day and the half on the left, the day's move on the right.
/// A `HStack` of `VStack`s with no fixed heights beyond the 44 pt minimum,
/// so Dynamic Type reflows it; the FIGURE truncates, never the label.
private struct DayReportHistoryRow: View {
    let item: DayReportHistoryItem

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.dayLabel)
                    .font(.system(.subheadline, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
                Text(DayReportHistorySection.kindLabel(item.kind))
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 6) {
                    Text(DayReportHistorySection.changeText(item))
                        .monospacedDigit()
                        .lineLimit(1)
                        .foregroundStyle(Color(item.dayChange?.direction.token ?? Tokens.textMuted))
                    if let pct = item.dayChangePct {
                        Text("(\(pct))")
                            .monospacedDigit()
                            .lineLimit(1)
                            .foregroundStyle(Color(item.dayChange?.direction.token ?? Tokens.textMuted))
                    }
                }
                .font(.subheadline)
                if let caption = DayReportHistorySection.changeCaption(item) {
                    Text(caption)
                        .font(.caption2)
                        .foregroundStyle(Color(Tokens.textMuted))
                        .lineLimit(1)
                }
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(Tokens.textMuted))
                .accessibilityHidden(true)
        }
        .frame(minHeight: 44)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var parts = [
            item.dayLabel,
            DayReportHistorySection.kindLabel(item.kind),
            DayReportHistorySection.changeText(item),
        ]
        if let pct = item.dayChangePct { parts.append(pct) }
        if let caption = DayReportHistorySection.changeCaption(item) { parts.append(caption) }
        return parts.joined(separator: ", ")
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
