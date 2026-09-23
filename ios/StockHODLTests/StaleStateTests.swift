import Foundation
import Testing

@testable import StockHODL

/// The rules three stores used to each own a copy of, now in one place and
/// therefore testable at all. Every case below was previously only observable
/// by driving a whole store against a fake server.
@Suite("Stale state")
struct StaleStateTests {
    @Test("a confirmed payload with nothing failing since claims nothing")
    func confirmedIsFresh() {
        var state = StaleState()
        state.succeeded(at: Date())

        #expect(state.freshness == .fresh)
        #expect(!state.isOffline)
    }

    @Test("one failure over a healthy network is noise; two are a verdict")
    func twoFailuresAreAVerdict() {
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        var state = StaleState()
        state.succeeded(at: taken)

        state.failed()
        #expect(state.freshness == .fresh, "a single failure on a train is not evidence")

        state.failed()
        #expect(state.freshness == .stale(since: taken))
    }

    @Test("a known-disconnected radio needs no second opinion")
    func disconnectedSkipsTheCounter() {
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        var state = StaleState()
        state.succeeded(at: taken)
        state.connectivityChanged(to: false)
        state.failed()

        // One failure, not two. Waiting for a second twenty-second timeout to
        // confirm what the OS already said is forty seconds of showing prices
        // that are known to be old.
        #expect(state.freshness == .disconnected(since: taken))
    }

    @Test("data painted from disk is stale from the first frame")
    func restoredIsUnconfirmed() {
        let taken = Date(timeIntervalSince1970: 1_700_000_000)
        var state = StaleState()
        state.restored(from: taken)

        // The cold-launch bug this flag exists for: `capturedAt` alone made a
        // snapshot indistinguishable from a fresh fetch.
        #expect(state.freshness == .stale(since: taken))
        #expect(state.isOffline)
    }

    @Test("a confirmed payload is not overwritten by a later disk read")
    func restoreDoesNotClobberConfirmed() {
        let fetched = Date(timeIntervalSince1970: 1_700_000_100)
        var state = StaleState()
        state.succeeded(at: fetched)
        state.restored(from: Date(timeIntervalSince1970: 1_600_000_000))

        #expect(state.capturedAt == fetched)
        #expect(state.freshness == .fresh)
    }

    @Test("a success clears the verdict and the counter")
    func successRecovers() {
        var state = StaleState()
        state.connectivityChanged(to: false)
        state.failed()
        state.failed()
        #expect(state.isOffline)

        state.connectivityChanged(to: true)
        state.succeeded(at: Date())
        #expect(state.freshness == .fresh)
        #expect(state.consecutiveFailures == 0)
    }

    @Test("a route reappearing does not by itself reset the backoff")
    func connectivityDoesNotResetFailures() {
        var state = StaleState()
        state.failed()
        state.failed()
        state.connectivityChanged(to: true)

        // A captive portal flaps `.satisfied` constantly. Zeroing here would
        // let it hold the pump at full cadence forever.
        #expect(state.consecutiveFailures == 2)
    }

    @Test("the first attempt goes out even if the monitor has not spoken yet")
    func firstAttemptIsAlwaysMade() {
        var state = StaleState()
        state.connectivityChanged(to: false)

        // `NWPathMonitor` takes a moment to deliver its first path, and
        // skipping the load the user is waiting for because of that half
        // second would be worse than one wasted request.
        #expect(state.shouldAttempt)

        state.failed()
        #expect(!state.shouldAttempt, "now it has been proved")
    }

    @Test("the failure count saturates rather than growing without bound")
    func failuresSaturate() {
        var state = StaleState()
        for _ in 0..<1000 { state.failed() }

        #expect(state.consecutiveFailures == 32)
    }
}

@Suite("Stale label")
struct StaleLabelTests {
    /// A fixed clock and a fixed calendar. A test that asks the device what
    /// time it is passes in Warsaw in August and fails in a CI container set
    /// to UTC in December.
    private static func calendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        calendar.locale = Locale(identifier: "en_GB")
        return calendar
    }

    private static let locale = Locale(identifier: "en_GB")

    private static func date(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)!
    }

    @Test("fresh says nothing at all")
    func freshHasNoLabel() {
        #expect(StaleLabel.label(for: .fresh) == nil)
    }

    @Test("today is a bare time")
    func todayIsATime() {
        let now = Self.date("2026-08-22T17:30:00+02:00")
        let taken = Self.date("2026-08-22T17:02:00+02:00")

        let label = StaleLabel.label(
            for: .stale(since: taken),
            now: now,
            calendar: Self.calendar(),
            locale: Self.locale
        )

        #expect(label?.text == "Data from 17:02")
        #expect(label?.isWarning == false)
    }

    @Test("yesterday says yesterday — the bug a bare time causes")
    func yesterdayIsNamed() {
        let now = Self.date("2026-08-22T09:15:00+02:00")
        let taken = Self.date("2026-08-21T17:02:00+02:00")

        let label = StaleLabel.label(
            for: .stale(since: taken),
            now: now,
            calendar: Self.calendar(),
            locale: Self.locale
        )

        // "Data from 17:02" at 09:15 reads as five o'clock THIS morning, or as
        // "a few minutes ago" if you glance at it. It was neither.
        #expect(label?.text == "yesterday 17:02" || label?.text == "Data from yesterday 17:02")
        #expect(label?.text.contains("yesterday") == true)
    }

    @Test("earlier this week carries the weekday")
    func thisWeekCarriesTheDay() {
        let now = Self.date("2026-08-22T09:15:00+02:00")
        let taken = Self.date("2026-08-19T17:02:00+02:00")

        let label = StaleLabel.label(
            for: .stale(since: taken),
            now: now,
            calendar: Self.calendar(),
            locale: Self.locale
        )

        #expect(label?.text.contains("Wed") == true)
        #expect(label?.text.contains("17:02") == true)
    }

    @Test("past three days it is a warning, not a footnote")
    func oldIsAWarning() {
        let now = Self.date("2026-08-22T09:15:00+02:00")
        let taken = Self.date("2026-08-12T17:02:00+02:00")

        let label = StaleLabel.label(
            for: .stale(since: taken),
            now: now,
            calendar: Self.calendar(),
            locale: Self.locale
        )

        #expect(label?.isWarning == true)
        // Past a week the weekday name starts repeating, so a date takes over.
        #expect(label?.text.contains("Aug") == true)
    }

    @Test("disconnected names the cause as well as the age")
    func disconnectedNamesTheCause() {
        let now = Self.date("2026-08-22T17:30:00+02:00")
        let taken = Self.date("2026-08-22T17:02:00+02:00")

        let label = StaleLabel.label(
            for: .disconnected(since: taken),
            now: now,
            calendar: Self.calendar(),
            locale: Self.locale
        )

        #expect(label?.text == "Offline · data from 17:02")
    }

    @Test("disconnected with nothing drawn says only the cause")
    func disconnectedWithNoAge() {
        #expect(StaleLabel.label(for: .disconnected(since: nil))?.text == "Offline")
    }

    @Test("stale with nothing cached does not claim data is out of date")
    func staleWithNoAge() {
        // There is no data. "Out of date" would be a claim about something
        // that does not exist.
        #expect(StaleLabel.label(for: .stale(since: nil))?.text == "Not updating")
    }

    @Test("a clock that moved backwards degrades to a time, not to \"in 3 hours\"")
    func futureCapturedAt() {
        let now = Self.date("2026-08-22T09:15:00+02:00")
        let taken = Self.date("2026-08-22T12:00:00+02:00")

        let label = StaleLabel.label(
            for: .stale(since: taken),
            now: now,
            calendar: Self.calendar(),
            locale: Self.locale
        )

        #expect(label?.text == "Data from 12:00")
    }
}

@Suite("Backoff")
struct BackoffTests {
    @Test("no failures means the cadence is untouched")
    func healthyIsUnchanged() {
        #expect(Backoff.delay(after: 0, base: .seconds(10)) == .seconds(10))
    }

    @Test("the delay doubles per failure, up to the ceiling")
    func doublesToACeiling() {
        #expect(Backoff.delay(after: 1, base: .seconds(10)) == .seconds(20))
        #expect(Backoff.delay(after: 2, base: .seconds(10)) == .seconds(40))
        #expect(Backoff.delay(after: 3, base: .seconds(10)) == Backoff.ceiling)
    }

    @Test("a long outage never walks the exponent past the ceiling")
    func longOutageIsClamped() {
        // A phone left offline overnight reaches this. Without the shift cap
        // it is an overflow rather than a delay.
        #expect(Backoff.delay(after: 32, base: .seconds(10)) == Backoff.ceiling)
    }

    @Test("a base already past the ceiling is not lengthened by it")
    func slowBaseIsNotSlowedFurther() {
        // The options poll is 60 s — already the ceiling — so failing should
        // not stretch it to four minutes.
        #expect(Backoff.delay(after: 4, base: .seconds(60)) == Backoff.ceiling)
    }
}
