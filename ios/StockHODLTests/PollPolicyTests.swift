import Foundation
import Testing

@testable import StockHODL

/// Ported from `src/lib/holdings/poll-policy.test.ts`. The cases are the same
/// cases deliberately: this is the one piece of gating logic that exists twice
/// in the codebase, and the value of a port is that it fails in the same places
/// the original would.
@Suite("Poll policy")
struct PollPolicyTests {
    @Test("the cadence runs during regular and both extended sessions")
    func activeStatuses() {
        #expect(PollPolicy.isActiveStatus(.marketStatusOpen))
        #expect(PollPolicy.isActiveStatus(.earlyTrading))
        #expect(PollPolicy.isActiveStatus(.lateTrading))
    }

    @Test("a closed or unknown market means no requests at all")
    func inactiveStatuses() {
        #expect(!PollPolicy.isActiveStatus(.closed))
        // `unknown` is what the server reports when it could not determine the
        // session. Polling into that would be guessing with the user's battery.
        #expect(!PollPolicy.isActiveStatus(.unknown))
    }

    @Test("an open market with nothing pollable does not poll")
    func structurallyEmpty() {
        // The portfolio holds only instruments the vendor cannot price. Polling
        // would fetch the same nulls every ten seconds forever.
        #expect(!PollPolicy.shouldPollQuotes(status: .marketStatusOpen, hasPollableSymbols: false))
    }

    @Test("a closed market does not poll even with pollable symbols")
    func closedWithSymbols() {
        #expect(!PollPolicy.shouldPollQuotes(status: .closed, hasPollableSymbols: true))
    }

    @Test("open plus pollable is the only combination that polls")
    func theOneActiveCase() {
        #expect(PollPolicy.shouldPollQuotes(status: .marketStatusOpen, hasPollableSymbols: true))
        #expect(PollPolicy.shouldPollQuotes(status: .earlyTrading, hasPollableSymbols: true))
        #expect(PollPolicy.shouldPollQuotes(status: .lateTrading, hasPollableSymbols: true))
    }

    @Test("a payload whose prices are all null still polls if the server says pollable")
    func transientEmptinessKeepsPolling() {
        // This is the whole point of the module. The vendor hiccupped and every
        // price came back null — deriving "nothing to poll for" from that would
        // kill the cadence permanently on a single blip, and the view would
        // never self-heal.
        let payload = LiveFixture.payload(
            status: .marketStatusOpen,
            hasPollableSymbols: true,
            holdings: [LiveFixture.holding(instrumentId: "i1", price: nil, valuePLN: nil)]
        )
        #expect(PollPolicy.shouldPoll(payload))
    }
}
