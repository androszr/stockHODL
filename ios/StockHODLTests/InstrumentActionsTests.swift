import Testing

@testable import StockHODL

/// The watch button's glyph-and-announcement rule, all four states. The
/// model is pure so this suite runs without mounting SwiftUI — the
/// `TopBarAdd` precedent.
@Suite("Watch action model")
struct InstrumentActionsTests {
    @Test("not watching, idle: outline glyph, honest value, enabled")
    func notWatchingIdle() {
        let model = WatchActionModel.current(isWatched: false, isToggling: false)
        #expect(model.systemImage == "binoculars")
        #expect(model.accessibilityValue == "Not watching")
        #expect(!model.isDisabled)
    }

    @Test("watching, idle: filled glyph, honest value, enabled")
    func watchingIdle() {
        let model = WatchActionModel.current(isWatched: true, isToggling: false)
        #expect(model.systemImage == "binoculars.fill")
        #expect(model.accessibilityValue == "Watching")
        #expect(!model.isDisabled)
    }

    @Test("not watching, toggling: disabled while the optimistic add saves")
    func notWatchingToggling() {
        let model = WatchActionModel.current(isWatched: false, isToggling: true)
        #expect(model.systemImage == "binoculars")
        #expect(model.accessibilityValue == "Not watching")
        #expect(model.isDisabled)
    }

    @Test("watching, toggling: filled AND disabled — a mid-flight unwatch cannot re-fire")
    func watchingToggling() {
        let model = WatchActionModel.current(isWatched: true, isToggling: true)
        #expect(model.systemImage == "binoculars.fill")
        #expect(model.accessibilityValue == "Watching")
        #expect(model.isDisabled)
    }

    @Test("identical states compare equal — what every #expect here leans on")
    func equality() {
        let a = WatchActionModel.current(isWatched: true, isToggling: false)
        let b = WatchActionModel.current(isWatched: true, isToggling: false)
        #expect(a == b)
    }
}
