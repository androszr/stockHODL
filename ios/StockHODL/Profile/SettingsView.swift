import SwiftUI

/// Settings — the half of the web's `/settings` that Profile does not already
/// cover.
///
/// Account, passkeys and sign-out live on `ProfileView` and are not repeated
/// here. What is left is the two facts a phone cannot derive: whether the
/// price feed is answering, and whether the server is currently accepting
/// password sign-in.
///
/// Appearance is absent on purpose — this app is dark-only on the phone (plan
/// A.8), and a toggle that did nothing would be worse than no toggle.
struct SettingsView: View {
    let store: SettingsStore
    /// Optional for the same reason `store` on `ProfileView` is: absent means
    /// the row is not drawn, which is what a preview without a network wants.
    var notifications: NotificationsStore?

    var body: some View {
        List {
            if let notifications {
                notificationsSection(notifications)
            }

            // FIRST, and unmissable when it is on. While recovery mode is
            // active a password is enough to reach this account, and a phone
            // that could not say so would leave the user with no way to learn
            // it. Buried under a diagnostics section it might as well not be
            // shown at all.
            if store.response?.recoveryMode == true {
                Section {
                    Text("Recovery mode is active")
                        .font(.system(.subheadline, weight: .medium))
                        .foregroundStyle(Color(Tokens.loss))
                    Text("Password sign-in is currently enabled. Once you have a working passkey, set RECOVERY_MODE=0 and redeploy.")
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textSecondary))
                }
            }

            Section("Market data") {
                if let response = store.response {
                    HStack(spacing: 8) {
                        // Reinforcement only — the words carry the verdict.
                        Circle()
                            .fill(Color(response.marketData.token))
                            .frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                        Text(response.marketData.title)
                            .font(.system(.subheadline, weight: .medium))
                            .foregroundStyle(Color(Tokens.textPrimary))
                    }
                    Text(response.marketData.detail)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textMuted))

                    if let fetched = response.lastPriceFetchedAtMs {
                        // A FETCH time, worded as one — never presented as a
                        // trade time. Formatted on the device so its own clock
                        // and locale apply.
                        LabeledContent(
                            "Last price fetched",
                            value: SettingsView.fetchedLabel(fetched)
                        )
                        .font(.caption)
                    }
                } else if store.isLoading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Checking…")
                            .font(.subheadline)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                } else {
                    Text(store.errorMessage ?? SettingsStore.genericError)
                        .font(.caption)
                        .foregroundStyle(Color(Tokens.textMuted))
                    Button("Try again") { Task { await store.load() } }
                        .foregroundStyle(Color(Tokens.accent))
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color(Tokens.surface0))
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .tokenSheetChrome()
        .task { await store.load() }
        .task {
            await notifications?.refreshAuthorizationStatus()
            // The server's idea of both switches — the toggles stay disabled
            // until it answers.
            await notifications?.load()
        }
        .refreshable {
            await store.load()
            await notifications?.load()
        }
    }

    /// The two notification switches, independent server-stored preferences
    /// behind one device registration: price alerts — 5% or more within 12
    /// hours, up or down, for anything held or watched
    /// (plans/2026-08-20-price-move-push-alerts.md) — and the daily summary —
    /// one push after the US close with the day's portfolio result
    /// (plans/2026-09-05-daily-portfolio-summary-push.md). Both off until
    /// asked. The toggles stay disabled until the server has answered
    /// `load()` (loading, or offline — a switch that cannot reach the server
    /// must not pretend to flip), and an OS-level denial disables and
    /// captions both, so neither ever looks on while doing nothing.
    @ViewBuilder
    private func notificationsSection(_ notifications: NotificationsStore) -> some View {
        let locked = notifications.isBusy || notifications.isDeniedByOS
            || notifications.isLoading || !notifications.hasLoaded
        Section {
            Toggle(
                "Price alerts",
                isOn: Binding(
                    get: { notifications.priceAlertsEnabled },
                    set: { newValue in Task { await notifications.setPriceAlerts(newValue) } }
                )
            )
            .disabled(locked)
            Toggle(
                "Daily reports (morning + close)",
                isOn: Binding(
                    get: { notifications.dailySummaryEnabled },
                    set: { newValue in Task { await notifications.setDailySummary(newValue) } }
                )
            )
            .disabled(locked)
        } footer: {
            if notifications.isDeniedByOS {
                Text("Notifications are turned off for StockHODL in iOS Settings. Enable them there first.")
            } else {
                Text("Price alerts: a push when a stock you hold or watch moves 5% or more within 12 hours. Daily reports: a brief about an hour before the US open and a report after the close, each opening that day's Day report.")
            }
        }
        .alert(
            notifications.errorMessage ?? "",
            isPresented: Binding(
                get: { notifications.errorMessage != nil },
                set: { if !$0 { notifications.dismissError() } }
            )
        ) {
            Button("OK") { notifications.dismissError() }
        }
    }

    /// pl-PL, like every other formatted instant in this app, and pinned to
    /// Warsaw for the same reason the web pins it: the single user is there,
    /// and a device travelling would otherwise relabel the same fetch.
    static func fetchedLabel(_ ms: Int) -> String {
        var style = Date.FormatStyle.dateTime
            .day()
            .month(.abbreviated)
            .hour(.twoDigits(amPM: .omitted))
            .minute(.twoDigits)
            .locale(ChartLabels.locale)
        // Set as a PROPERTY: the `.timeZone()` builder method selects which
        // zone SYMBOL to print ("CEST"), it does not change the zone the
        // instant is rendered in.
        style.timeZone = TimeZone(identifier: "Europe/Warsaw") ?? .current
        return Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(style)
    }
}
