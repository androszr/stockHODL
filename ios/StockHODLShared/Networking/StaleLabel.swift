import Foundation

/// The sentence the staleness bar says.
///
/// A plain function over `Freshness` rather than string-building inside a
/// `View`, for one reason: this is the only place in the app that makes a
/// CLAIM ABOUT MONEY'S AGE, and a claim worth making is a claim worth testing.
/// The old bar said `Data from 17:02` and nothing else, which is true and
/// useless once the figure is a day old — 17:02 reads as "five minutes ago"
/// at half past five, and as "this morning" at any other hour, and it was
/// neither. Yesterday's close rendered as a bare time is the single most
/// misleading thing a portfolio screen can do.
enum StaleLabel {
    /// Past this, the bar stops being a footnote and starts being a warning.
    /// Three days is chosen against the market week: a Monday-morning launch
    /// showing Friday's close is ordinary and needs no alarm, while anything
    /// older means the app has genuinely not spoken to the server in a way the
    /// user should notice.
    static let warnAfter: TimeInterval = 3 * 24 * 60 * 60

    struct Label: Equatable, Sendable {
        let text: String
        /// Whether to draw it as a warning rather than as a muted footnote.
        let isWarning: Bool
    }

    /// Nil when the screen owes no disclosure at all.
    static func label(
        for freshness: Freshness,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> Label? {
        switch freshness {
        case .fresh:
            return nil

        case let .disconnected(since):
            guard let since else {
                // Disconnected with nothing drawn yet. The screen behind this
                // is the error state, not a list of prices, so there is no age
                // to report — only the cause.
                return Label(text: "Offline", isWarning: false)
            }
            return Label(
                text: "Offline · data from \(age(of: since, now: now, calendar: calendar, locale: locale))",
                isWarning: isOld(since, now: now)
            )

        case let .stale(since):
            guard let since else {
                // Failing repeatedly with nothing cached. "Out of date" would
                // be a lie about data that does not exist; the honest claim is
                // only that we are not getting through.
                return Label(text: "Not updating", isWarning: false)
            }
            return Label(
                text: "Data from \(age(of: since, now: now, calendar: calendar, locale: locale))",
                isWarning: isOld(since, now: now)
            )
        }
    }

    static func isOld(_ since: Date, now: Date) -> Bool {
        now.timeIntervalSince(since) >= warnAfter
    }

    /// How old, in the shortest form that is still unambiguous.
    ///
    /// The ladder is deliberate. A bare time is only unambiguous TODAY; the
    /// day of the week carries the rest of the week (a phone offline since
    /// Friday says "Fri 17:02", which is exactly how a person would say it);
    /// past that a weekday name starts repeating, so the date takes over.
    static func age(
        of since: Date,
        now: Date,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        // A capturedAt in the FUTURE is not a data point, it is a clock the
        // user changed. Reporting "in 3 hours" would be technically accurate
        // and read as a bug, so it degrades to the today-shape.
        if since > now {
            return time(since, locale: locale)
        }

        if calendar.isDate(since, inSameDayAs: now) {
            return time(since, locale: locale)
        }
        // `isDateInYesterday` is relative to the device clock, not `now`.
        // Tests (and any caller) inject `now`; compare against that day.
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(since, inSameDayAs: yesterday) {
            return "yesterday \(time(since, locale: locale))"
        }

        let days = calendar.dateComponents([.day], from: since, to: now).day ?? 0
        if days < 7 {
            // `.dateTime` with only the weekday asked for, rather than a
            // `FormatStyle` with the other fields switched off: the `.omitted`
            // spellings that would do that are iOS 18, and this app ships
            // lower.
            let weekday = since.formatted(.dateTime.locale(locale).weekday(.abbreviated))
            return "\(weekday) \(time(since, locale: locale))"
        }

        return since.formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale)
        )
    }

    private static func time(_ date: Date, locale: Locale) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale))
    }
}
