import Foundation
import Observation
import UserNotifications
#if canImport(UIKit)
    import UIKit
#endif

/// The Settings notification switches' data layer — "Price alerts"
/// (plans/2026-08-20-price-move-push-alerts.md) and "Daily summary"
/// (plans/2026-09-05-daily-portfolio-summary-push.md), with Daily reports
/// covering both the morning brief and close push, two INDEPENDENT
/// server-stored preferences behind one device registration.
///
/// The server is the source of truth: `load()` GETs both switches when
/// Settings opens (the toggles stay disabled until it answers — a control
/// showing a cached guess must not accept taps it cannot honour), and
/// flipping either switch PUTs both booleans, reverting on failure. The
/// device token is registered while ANY switch is on and DELETEd only when
/// BOTH are off — one switch is a preference, the registration is the shared
/// plumbing underneath both.
@MainActor
@Observable
final class NotificationsStore {
    private(set) var priceAlertsEnabled: Bool
    private(set) var dailySummaryEnabled: Bool
    /// True while `load()` is on the wire — the toggles are disabled then.
    private(set) var isLoading = false
    /// True once the SERVER has answered. Until then the booleans are the
    /// local display cache, good enough to paint and not good enough to flip.
    private(set) var hasLoaded = false
    private(set) var isBusy = false
    private(set) var errorMessage: String?
    /// True once the OS reports notifications are denied — the toggles then
    /// show a "disabled in iOS Settings" state rather than controls that
    /// look on but silently do nothing (`requestAuthorization` no-ops on a
    /// prior denial rather than re-prompting).
    private(set) var isDeniedByOS = false

    private let client: PushTokenClient
    private let tokenProvider: @MainActor () -> String?
    private let environment: PushTokenEnvironment
    private let defaults: UserDefaults
    private let center: UNUserNotificationCenter

    /// Display caches only, since the preferences moved server-side — the
    /// server row is what the crons read. The old single-toggle installs
    /// were backfilled a `priceAlerts: true` row, so the first `load()`
    /// answers what the device already believed.
    private static let priceAlertsKey = "pushAlertsEnabled"
    private static let dailySummaryKey = "pushDailySummaryEnabled"
    /// NOT a cache: the only handle for unregistering the device. Dropping it
    /// would orphan a server row that keeps pushing to a signed-out device.
    private static let registeredTokenKey = "pushAlertsDeviceToken"

    var anyEnabled: Bool { priceAlertsEnabled || dailySummaryEnabled }

    init(
        client: PushTokenClient,
        tokenProvider: @escaping @MainActor () -> String?,
        environment: PushTokenEnvironment,
        defaults: UserDefaults = .standard,
        center: UNUserNotificationCenter = .current()
    ) {
        self.client = client
        self.tokenProvider = tokenProvider
        self.environment = environment
        self.defaults = defaults
        self.center = center
        priceAlertsEnabled = defaults.bool(forKey: Self.priceAlertsKey)
        dailySummaryEnabled = defaults.bool(forKey: Self.dailySummaryKey)
    }

    func refreshAuthorizationStatus() async {
        let settings = await center.notificationSettings()
        isDeniedByOS = settings.authorizationStatus == .denied
    }

    /// Fetches the server's idea of both switches. Called when Settings
    /// opens; a failure leaves the cached display state painted and the
    /// toggles disabled (`hasLoaded` stays false) — offline, a switch that
    /// cannot reach the server must not pretend to flip.
    func load() async {
        guard !isLoading, let bearer = tokenProvider() else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            let preferences = try await client.preferences(bearerToken: bearer)
            priceAlertsEnabled = preferences.priceAlerts
            dailySummaryEnabled = preferences.dailySummary
            cacheDisplayState()
            hasLoaded = true
        } catch {
            #if DEBUG
                print("[push] preferences load failed: \(error)")
            #endif
        }
    }

    func setPriceAlerts(_ enabled: Bool) async {
        await apply(priceAlerts: enabled, dailySummary: dailySummaryEnabled)
    }

    func setDailySummary(_ enabled: Bool) async {
        await apply(priceAlerts: priceAlertsEnabled, dailySummary: enabled)
    }

    private func apply(priceAlerts: Bool, dailySummary: Bool) async {
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }

        let wasAnyOn = anyEnabled
        let willAnyBeOn = priceAlerts || dailySummary
        let previousPriceAlerts = priceAlertsEnabled
        let previousDailySummary = dailySummaryEnabled

        // Turning the FIRST switch on (none previously on) is what asks the
        // OS. Later flips ride the grant that already exists.
        if !wasAnyOn && willAnyBeOn {
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                await refreshAuthorizationStatus()
                guard granted else { return }
            } catch {
                errorMessage = "Could not enable notifications."
                return
            }
        }

        guard let bearer = tokenProvider() else { return }
        do {
            try await client.updatePreferences(
                NotificationPreferences(dailySummary: dailySummary, priceAlerts: priceAlerts),
                bearerToken: bearer
            )
        } catch {
            // Revert: the server row did not change, so neither may the view.
            priceAlertsEnabled = previousPriceAlerts
            dailySummaryEnabled = previousDailySummary
            errorMessage = "Could not save notification settings."
            return
        }

        priceAlertsEnabled = priceAlerts
        dailySummaryEnabled = dailySummary
        cacheDisplayState()

        if willAnyBeOn {
            #if canImport(UIKit)
                UIApplication.shared.registerForRemoteNotifications()
            #endif
            // The device token itself arrives asynchronously through
            // `PushCoordinator` — this finishes registration if the token is
            // already known (a later launch); `tokenReceived` finishes it the
            // first time, whenever the delegate callback lands.
            if let token = PushCoordinator.shared.deviceToken {
                await tokenReceived(token)
            }
        } else {
            // BOTH off: the registration goes with them.
            await unregisterCurrentToken()
        }
    }

    /// Called when `PushCoordinator` learns the APNs device token — which, at
    /// first launch, can be seconds after the enabling flip already returned.
    /// Every later launch fires this again with (usually) the same token,
    /// which is harmless: the server route upserts by token.
    func tokenReceived(_ hexToken: String) async {
        guard anyEnabled, let bearer = tokenProvider() else { return }
        do {
            try await client.register(deviceToken: hexToken, environment: environment, bearerToken: bearer)
            defaults.set(hexToken, forKey: Self.registeredTokenKey)
        } catch {
            #if DEBUG
                print("[push] token registration failed: \(error)")
            #endif
        }
    }

    /// Sign-out: unregister the CURRENT device token so an account that is
    /// signed out of stops receiving its pushes, while leaving the LOCAL
    /// display cache exactly as the user set it — re-enabling requires no
    /// re-grant of OS permission, but a fresh sign-in re-registers the token
    /// before any push can reach this device again. Must run BEFORE the
    /// session token is revoked, the same ordering `live?.purge()` etc.
    /// already follow in `SignedInView`.
    func purge() async {
        await unregisterCurrentToken()
    }

    private func cacheDisplayState() {
        defaults.set(priceAlertsEnabled, forKey: Self.priceAlertsKey)
        defaults.set(dailySummaryEnabled, forKey: Self.dailySummaryKey)
    }

    /// Clears the local record ONLY when the server actually dropped the row.
    ///
    /// This is the opposite tradeoff from the session token, which is purged
    /// whether or not the revoke succeeded (see `docs/context.md`): there, the
    /// dangerous leftover is on the DEVICE. Here it is on the SERVER — a row
    /// that survives keeps pushing this account's alerts to a signed-out
    /// phone. Forgetting the token locally would destroy the only handle we
    /// have to delete it, so a failure keeps it for the next attempt.
    private func unregisterCurrentToken() async {
        guard let token = defaults.string(forKey: Self.registeredTokenKey),
              let bearer = tokenProvider() else { return }
        do {
            try await client.unregister(deviceToken: token, environment: environment, bearerToken: bearer)
            defaults.removeObject(forKey: Self.registeredTokenKey)
        } catch {
            #if DEBUG
                print("[push] token unregistration failed, keeping it for retry: \(error)")
            #endif
        }
    }

    func dismissError() { errorMessage = nil }
}
