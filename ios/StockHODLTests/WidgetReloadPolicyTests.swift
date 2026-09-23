import Foundation
import Testing

@testable import StockHODL

/// The refresh cadence, in test form: a fixed 5 minutes, always — no branch
/// on market status, resume instant, or session state.
@Suite("WidgetReloadPolicy")
struct WidgetReloadPolicyTests {
    private let now = Date(timeIntervalSince1970: 1_754_800_000)

    private func market(
        _ status: MarketStatus,
        resumesAt: Date? = nil
    ) -> LiveMarket {
        LiveMarket(
            nextTransitionAtMs: nil,
            nextTransitionKind: nil,
            pollingResumesAtMs: resumesAt.map { Int($0.timeIntervalSince1970 * 1000) },
            serverNowMs: Int(now.timeIntervalSince1970 * 1000),
            status: status
        )
    }

    @Test(
        "every market status gets the same fixed interval",
        arguments: [
            MarketStatus.marketStatusOpen, .earlyTrading, .lateTrading, .closed, .unknown,
        ]
    )
    func fixedRegardlessOfStatus(status: MarketStatus) {
        let next = WidgetReloadPolicy.next(after: market(status), now: now)
        #expect(next.timeIntervalSince(now) == WidgetReloadPolicy.fixedInterval)
    }

    @Test("a named resume instant does not change the fixed interval")
    func resumeInstantIsIgnored() {
        let open = now.addingTimeInterval(9 * 60 * 60)
        let next = WidgetReloadPolicy.next(after: market(.closed, resumesAt: open), now: now)
        #expect(next.timeIntervalSince(now) == WidgetReloadPolicy.fixedInterval)
    }

    @Test("a failure retries on the same fixed interval")
    func retry() {
        let next = WidgetReloadPolicy.retry(now: now)
        #expect(next.timeIntervalSince(now) == WidgetReloadPolicy.fixedInterval)
    }
}
