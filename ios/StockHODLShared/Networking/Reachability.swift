import Foundation
import Network
import Observation

/// Whether this device has a route off itself.
///
/// Before this existed the app had no idea. Every store inferred the network's
/// health from its own failures — two in a row meant "offline" — which is a
/// reasonable last resort and a poor first one: it cannot tell a tunnel from a
/// 500, it cannot say anything until it has already wasted two 20-second
/// timeouts, and, worst of the three, it never learns the network came BACK.
/// A phone that regained signal sat there showing yesterday's prices until the
/// user backgrounded the app or pulled to refresh, because nothing in the
/// process was listening.
///
/// `NWPathMonitor` answers all three. It is deliberately used as a HINT and
/// not as a verdict: `.satisfied` means the OS believes a route exists, which
/// on a captive-portal Wi-Fi is optimistic, so the failure counters stay
/// exactly where they were. What this adds is the two things counting could
/// never do — an immediate, correct "there is no network" the moment the first
/// request fails, and an edge to refresh on when the route comes back.
///
/// `@MainActor` because every reader is a store or a view on the main actor,
/// and the monitor's own queue is a background one that hops here to publish.
@MainActor
@Observable
final class Reachability {
    /// The process-wide instance. A singleton on purpose, and the distinction
    /// worth naming is against `UserDefaults`, which stores inject rather than
    /// reach for: defaults hold ACCOUNT state, where two tests sharing one
    /// means the first decides what the second opens on. This holds the state
    /// of the radio — a fact about the device, identical for every reader, and
    /// owned by the OS rather than by us. Stores still take an injected
    /// `isConnected` closure so no test ever touches this object.
    static let shared = Reachability()

    /// Optimistic until told otherwise. A monitor takes a moment to deliver
    /// its first path, and starting at `false` would make every cold launch
    /// flash an offline banner over data that was about to load fine.
    private(set) var isConnected = true

    /// The interface behind the route, when there is one. Not shown anywhere
    /// yet; it exists because "expensive" (cellular, hotspot) is the axis a
    /// future decision about prefetching would turn on, and the monitor
    /// already carries it.
    private(set) var isExpensive = false

    private var monitor: NWPathMonitor?

    /// Begin watching. Idempotent — a second call is a no-op rather than a
    /// second monitor, because the shell calls it from `.task`, which SwiftUI
    /// may run again.
    func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            let connected = path.status == .satisfied
            let expensive = path.isExpensive
            Task { @MainActor [weak self] in
                self?.apply(connected: connected, expensive: expensive)
            }
        }
        monitor.start(queue: DispatchQueue(label: "stockhodl.reachability"))
    }

    /// Internal rather than private so a test can drive the object directly
    /// without an `NWPathMonitor` — there is no way to fake a real path, and
    /// the logic worth pinning is what the app does on the EDGE, not how the
    /// framework reports it.
    func apply(connected: Bool, expensive: Bool = false) {
        isExpensive = expensive
        // Assigning an unchanged value would still invalidate every SwiftUI
        // view reading it — `@Observable` tracks writes, not differences — and
        // `NWPathMonitor` republishes the same path on unrelated interface
        // changes several times a minute.
        guard connected != isConnected else { return }
        isConnected = connected
    }

    /// Stop watching. Nothing in the app calls this — the shared instance
    /// lives as long as the process — but a `deinit` cannot: this class is
    /// `@MainActor` and a deinitialiser is not, so touching `monitor` there is
    /// a Swift 6 error rather than a tidy-up.
    func stop() {
        monitor?.cancel()
        monitor = nil
    }
}
