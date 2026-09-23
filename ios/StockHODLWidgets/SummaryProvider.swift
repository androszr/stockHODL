import WidgetKit

/// The timeline, which for this widget is always exactly one entry.
///
/// A multi-entry timeline is for content the widget can predict — a countdown,
/// a calendar. A share price is the opposite of predictable: the only honest
/// future entry would repeat the present one, so the timeline carries what is
/// true now and a date at which to ask again. That date is the whole cadence
/// decision, and it lives in `WidgetReloadPolicy` where it can be tested.
struct SummaryProvider: TimelineProvider {
    /// Constructed per refresh rather than held: an extension process is torn
    /// down between wakes, so there is nothing to keep warm.
    private let source = WidgetDataSource()

    func placeholder(in context: Context) -> SummaryEntry {
        SummaryEntry.placeholder()
    }

    /// The gallery preview. `context.isPreview` means the system is drawing the
    /// picker, where a network round trip would stall the browse — so it gets
    /// the same sample the placeholder uses.
    func getSnapshot(in context: Context, completion: @escaping (SummaryEntry) -> Void) {
        guard !context.isPreview else {
            completion(SummaryEntry.placeholder())
            return
        }
        let reply = Reply(completion)
        Task {
            let now = Date()
            reply.send(SummaryEntry(date: now, outcome: await source.load(now: now)))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SummaryEntry>) -> Void) {
        let reply = Reply(completion)
        Task {
            let now = Date()
            let outcome = await source.load(now: now)
            let next: Date =
                switch outcome {
                case let .figures(payload, _): WidgetReloadPolicy.next(after: payload.market, now: now)
                // Nothing arrived, so there is no session to follow — and a
                // signed-out widget must not re-ask on the trading cadence when
                // only the user opening the app can change the answer.
                case .signedOut, .unavailable: WidgetReloadPolicy.retry(now: now)
                }

            reply.send(
                Timeline(entries: [SummaryEntry(date: now, outcome: outcome)], policy: .after(next))
            )
        }
    }
}

/// A `TimelineProvider` completion handler, carried into a `Task`.
///
/// `TimelineProvider` predates strict concurrency: its completion is a plain
/// escaping closure, not a `@Sendable` one, so handing it to a `Task` is a
/// data race as far as the compiler can tell — and under
/// `SWIFT_STRICT_CONCURRENCY = complete` that is an error, not a warning.
///
/// The unchecked conformance is the narrow, arguable-in-writing kind rather
/// than a shrug: WidgetKit hands the closure over on the caller's queue and
/// expects it back exactly once, this type calls it exactly once, and nothing
/// else ever touches it. The alternative — implementing the async requirements
/// instead — is not available: this SDK still declares only the
/// completion-handler pair.
private struct Reply<Value>: @unchecked Sendable {
    private let completion: (Value) -> Void

    init(_ completion: @escaping (Value) -> Void) {
        self.completion = completion
    }

    func send(_ value: Value) { completion(value) }
}
