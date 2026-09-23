import Foundation
import Testing

@testable import StockHODL

/// The join between the server-sorted live payload and the static watch rows
/// — the pure model `WatchlistView` iterates, so the server sort cannot be
/// silently discarded and in-flight rows cannot vanish.
@Suite("Watchlist sections")
struct WatchlistSectionsTests {
    private func liveItem(
        _ instrumentId: String,
        group: TargetGroup,
        target: TargetStatus? = nil
    ) -> LiveWatchItem {
        LiveWatchItem(
            dayPct: nil,
            extended: nil,
            instrumentId: instrumentId,
            price: nil,
            target: target,
            targetGroup: group
        )
    }

    private func payload(_ items: [LiveWatchItem]) -> WatchlistPayload {
        LiveFixture.watchPayload(items: items)
    }

    @Test("groups follow the live payload's verdict, in the server's order")
    func groupsFollowServerOrder() {
        let items = ["a", "b", "c", "d"].map { LiveFixture.watched(instrumentId: $0, symbol: $0) }
        // The server sorted: near(c), set(a), none(b, d).
        let sections = WatchlistSections.build(
            items: items,
            live: payload([
                liveItem("c", group: .near),
                liveItem("a", group: .targetGroupSet),
                liveItem("b", group: TargetGroup.none),
                liveItem("d", group: TargetGroup.none),
            ])
        )

        #expect(sections.map(\.title) == ["Near a target", "Has a target", "No target"])
        #expect(sections[0].items.map(\.instrumentId) == ["c"])
        #expect(sections[1].items.map(\.instrumentId) == ["a"])
        #expect(sections[2].items.map(\.instrumentId) == ["b", "d"])
    }

    @Test("static leftovers (quotes in flight) append to the none section in insertion order")
    func leftoversAppendToNone() {
        let items = ["a", "b", "c"].map { LiveFixture.watched(instrumentId: $0, symbol: $0) }
        // The live baseline predates b and c being watched.
        let sections = WatchlistSections.build(
            items: items,
            live: payload([liveItem("a", group: .near)])
        )

        #expect(sections.map(\.title) == ["Near a target", "No target"])
        #expect(sections[1].items.map(\.instrumentId) == ["b", "c"])
    }

    @Test("a live row whose static half is gone (unwatched since) is dropped")
    func unwatchedLiveRowsDrop() {
        let sections = WatchlistSections.build(
            items: [LiveFixture.watched(instrumentId: "a", symbol: "A")],
            live: payload([
                liveItem("gone", group: .near),
                liveItem("a", group: TargetGroup.none),
            ])
        )

        #expect(sections.count == 1)
        #expect(sections[0].title == nil)
        #expect(sections[0].items.map(\.instrumentId) == ["a"])
    }

    @Test("no live payload yet is one unlabeled section — the offline screen, unchanged")
    func nilPayloadIsOneUnlabeledSection() {
        let items = ["a", "b"].map { LiveFixture.watched(instrumentId: $0, symbol: $0) }
        let sections = WatchlistSections.build(items: items, live: nil)

        #expect(sections.count == 1)
        #expect(sections[0].title == nil)
        #expect(sections[0].items.map(\.instrumentId) == ["a", "b"])
    }

    @Test("everything in none — hit-only included — renders with no headers at all")
    func allNoneHasNoHeaders() {
        let items = ["a", "b"].map { LiveFixture.watched(instrumentId: $0, symbol: $0) }
        let hit = TargetStatus(
            hitOnly: true,
            near: false,
            sentence: "Your 190,00 USD line has been hit",
            side: nil,
            text: "Hit"
        )
        let sections = WatchlistSections.build(
            items: items,
            live: payload([
                liveItem("a", group: TargetGroup.none),
                liveItem("b", group: TargetGroup.none, target: hit),
            ])
        )

        #expect(sections.count == 1)
        #expect(sections[0].title == nil)
        #expect(sections[0].items.map(\.instrumentId) == ["a", "b"])
    }

    @Test("no watched rows means no sections, whatever the payload says")
    func emptyItemsMeansNoSections() {
        #expect(WatchlistSections.build(items: [], live: nil).isEmpty)
        #expect(
            WatchlistSections.build(
                items: [],
                live: payload([liveItem("ghost", group: .near)])
            ).isEmpty
        )
    }

    @Test("a duplicated live row cannot list a stock twice")
    func duplicateLiveRowsCollapse() {
        let sections = WatchlistSections.build(
            items: [LiveFixture.watched(instrumentId: "a", symbol: "A")],
            live: payload([
                liveItem("a", group: .near),
                liveItem("a", group: TargetGroup.none),
            ])
        )

        #expect(sections.count == 1)
        #expect(sections[0].title == "Near a target")
        #expect(sections[0].items.map(\.instrumentId) == ["a"])
    }
}
