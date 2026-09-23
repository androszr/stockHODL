import Foundation
import WidgetKit

/// A snapshot store that also tells the widgets their world moved.
///
/// A decorator rather than a line inside `LiveStore` for two reasons. `LiveStore`
/// deliberately names nothing device-shaped so it can be driven by fakes in a
/// test, and `WidgetKit` is exactly such a name. And the trigger is already
/// exactly right at this seam: a new snapshot is written precisely when fresh
/// figures arrived, and cleared precisely on sign-out — the two moments a
/// widget is wrong until it reloads.
///
/// This is a nudge, not the widgets' data path. They fetch for themselves on
/// their own timeline; what this buys is that a user who just looked at the
/// app finds the same numbers on the Home Screen when they leave it, without
/// spending a scheduled reload to discover them.
///
/// `reloadAllTimelines` is cheap when nothing is installed — the system has no
/// timelines to rebuild — so there is nothing to guard here.
struct WidgetNudgingSnapshotStore: SnapshotStoring {
    let wrapped: any SnapshotStoring

    init(wrapping wrapped: any SnapshotStoring = AppGroupSnapshotStore()) {
        self.wrapped = wrapped
    }

    func read() -> Snapshot? { wrapped.read() }

    func write(_ snapshot: Snapshot) {
        wrapped.write(snapshot)
        WidgetCenter.shared.reloadAllTimelines()
    }

    func clear() {
        wrapped.clear()
        // Sign-out. The widget still holds its own cached payload and its own
        // token read; reloading is what makes it discover both are gone
        // instead of showing a signed-out user their balance.
        WidgetCenter.shared.reloadAllTimelines()
    }
}
