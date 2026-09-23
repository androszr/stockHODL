import Foundation
import Testing
import UIKit

@testable import StockHODL

/// One-pixel PNG — enough for `UIImage(data:)` to succeed, which is all the
/// loader cares about.
private func pngBytes() -> Data {
    UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).pngData { context in
        UIColor.gray.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
    }
}

/// Every case here passes `NoImageDisk()` deliberately: this suite is about
/// the in-memory half — what is asked for twice, what is remembered, what is
/// not — and a real cache directory would carry one case's PNG into the next
/// case and into the next RUN. The disk half has its own suite, in
/// `RemoteImageDiskTests`, where the directory is a temporary one.
@Suite("Logo loader")
struct LogoLoaderTests {
    @Test("bytes are fetched once and served from memory afterwards")
    func cachesHits() async {
        let calls = Counter()
        let bytes = pngBytes()
        let loader = LogoLoader(disk: NoImageDisk()) { _ in
            calls.bump()
            return .bytes(bytes)
        }

        #expect(loader.cached("AAPL") == nil)
        #expect(await loader.image(for: "AAPL") != nil)
        #expect(await loader.image(for: "AAPL") != nil)

        #expect(calls.value == 1)
        // A synchronous hit is what lets a scrolled-back tile paint opaque on
        // its first frame instead of fading in again.
        #expect(loader.cached("AAPL") != nil)
    }

    @Test("a definitive miss is remembered too")
    func cachesMisses() async {
        let calls = Counter()
        let loader = LogoLoader(disk: NoImageDisk()) { _ in
            calls.bump()
            return .absent
        }

        #expect(await loader.image(for: "CDR.WA") == nil)
        #expect(await loader.image(for: "CDR.WA") == nil)

        // Most of this portfolio has no vendor icon. Without the negative set
        // every scroll would re-ask the server for the 404 it already gave.
        #expect(calls.value == 1)
    }

    @Test("a request that never finished is NOT remembered")
    func retriesFailures() async {
        // The bug this suite exists to keep fixed. A tile scrolled off screen
        // has its `.task` cancelled mid-request, and at launch the first tiles
        // render before the session token is readable — both used to arrive
        // here as an indistinguishable nil and file the ticker as
        // permanently logo-less, so an arbitrary handful of holdings showed a
        // monogram until the app was force-quit. Meanwhile the server had
        // answered 200 for every one of them.
        let calls = Counter()
        let bytes = pngBytes()
        let loader = LogoLoader(disk: NoImageDisk()) { _ in
            calls.bump()
            return calls.value == 1 ? .failed : .bytes(bytes)
        }

        #expect(await loader.image(for: "GOOGL") == nil)
        // Second appearance: it must ask again, and it must succeed.
        #expect(await loader.image(for: "GOOGL") != nil)
        #expect(calls.value == 2)
    }

    @Test("undecodable bytes count as a miss, not as an image")
    func rejectsGarbage() async {
        let loader = LogoLoader(disk: NoImageDisk()) { _ in .bytes(Data("not an image".utf8)) }

        #expect(await loader.image(for: "AAPL") == nil)
        #expect(loader.cached("AAPL") == nil)
    }

    @Test("purge clears both caches")
    func purges() async {
        let calls = Counter()
        let bytes = pngBytes()
        let loader = LogoLoader(disk: NoImageDisk()) { _ in
            calls.bump()
            return .bytes(bytes)
        }

        _ = await loader.image(for: "AAPL")
        loader.purge()

        #expect(loader.cached("AAPL") == nil)
        _ = await loader.image(for: "AAPL")
        #expect(calls.value == 2)
    }

    @Test("the default loader is monograms all the way down")
    func noLoader() async {
        let loader = NoLogoLoader()
        #expect(loader.cached("AAPL") == nil)
        #expect(await loader.image(for: "AAPL") == nil)
    }
}

/// The countdown is arithmetic on epoch milliseconds, which is exactly the
/// kind of thing that works until a Friday evening. Ported case for case from
/// `formatRemaining` in `market-status-bar.tsx`.
@Suite("Market status bar")
struct MarketStatusBarTests {
    private func at(_ ms: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(ms) / 1000) }

    @Test("hours, minutes and seconds are zero-padded below the hour")
    func clock() {
        let now = at(0)
        #expect(MarketStatusBar.remaining(until: 3_600_000, now: now) == "1:00:00")
        #expect(MarketStatusBar.remaining(until: 65_000, now: now) == "0:01:05")
        #expect(MarketStatusBar.remaining(until: 45_296_000, now: now) == "12:34:56")
    }

    @Test("days appear only once there is a day to show")
    func days() {
        let now = at(0)
        #expect(MarketStatusBar.remaining(until: 86_399_000, now: now) == "23:59:59")
        #expect(MarketStatusBar.remaining(until: 86_400_000, now: now) == "1d 0:00:00")
        #expect(MarketStatusBar.remaining(until: 180_000_000, now: now) == "2d 2:00:00")
    }

    @Test("a boundary already passed clamps to zero rather than counting up")
    func clamps() {
        // The transition instant is server-computed and the phone's clock is
        // its own; a device a few seconds ahead must not render "-0:00:03".
        #expect(MarketStatusBar.remaining(until: 0, now: at(9_000)) == "0:00:00")
    }

    @Test("the word carries the state, so every status has one")
    func words() {
        #expect(MarketStatusBar.word(for: .marketStatusOpen) == "Open")
        #expect(MarketStatusBar.word(for: .earlyTrading) == "Pre-market")
        #expect(MarketStatusBar.word(for: .lateTrading) == "After hours")
        #expect(MarketStatusBar.word(for: .closed) == "Closed")
        #expect(MarketStatusBar.word(for: .unknown) == "Status unavailable")
    }

    @Test("the verb says which way the boundary goes")
    func verbs() {
        #expect(MarketStatusBar.verb(.close) == "closes in")
        #expect(MarketStatusBar.verb(.marketTransitionKindOpen) == "opens in")
    }
}

/// A counter that several concurrent fetches can bump — the loader is
/// deliberately lock-based rather than an actor, so its test has to be too.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func bump() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

@Suite("Bull mark")
struct BullMarkTests {
    @Test("the illustrated brand assets are in the app bundle")
    func illustratedAssetsArePresent() {
        #expect(UIImage(named: "BullMark") != nil)
        #expect(UIImage(named: "WidgetMark") != nil)
        #expect(UIImage(named: "BearStill") != nil)
    }
}

@Suite("App tabs")
struct AppTabTests {
    /// The bar mirrors the web `NAV` — same four slots, same order. If this
    /// fails, one of the two apps moved and the other did not.
    @Test("the four slots are the web bar's four slots, in order")
    func mirrorsWebNav() {
        #expect(AppTab.allCases == [.dashboard, .holdings, .options, .watchlist])
        #expect(AppTab.allCases.map(\.title) == ["Dashboard", "Holdings", "Options", "Watchlist"])
    }

    @Test("every slot names a real SF Symbol")
    func iconsResolve() {
        for tab in AppTab.allCases {
            #expect(UIImage(systemName: tab.systemImage) != nil, "\(tab.systemImage) is not a symbol")
        }
    }

    @Test("the four glyphs are the trading-terminal set")
    func tradingTerminalIcons() {
        #expect(AppTab.allCases.map(\.systemImage) == [
            "chart.line.uptrend.xyaxis",
            "briefcase",
            "plusminus",
            "binoculars",
        ])
    }
}

@Suite("Top bar chrome")
struct TopBarChromeTests {
    @Test("a tab root shows a plus only on watchlist and options")
    func addOnTabRoots() {
        #expect(TopBarAdd.current(tab: .dashboard, destination: nil) == nil)
        #expect(TopBarAdd.current(tab: .holdings, destination: nil) == .transaction)
        #expect(TopBarAdd.current(tab: .options, destination: nil) == .option)
        #expect(TopBarAdd.current(tab: .watchlist, destination: nil) == .watchlist)
    }

    @Test("the journal is the only pushed screen with a plus")
    func addOnPushed() {
        #expect(TopBarAdd.current(tab: .holdings, destination: .transactions) == .transaction)
        #expect(TopBarAdd.current(tab: .holdings, destination: .instrument("AAPL")) == nil)
        #expect(TopBarAdd.current(tab: .holdings, destination: .dividends(nil)) == nil)
        #expect(TopBarAdd.current(tab: .holdings, destination: .analytics) == nil)
        #expect(TopBarAdd.current(tab: .watchlist, destination: .news(nil)) == nil)
        #expect(TopBarAdd.current(tab: .options, destination: .optionContract("k")) == nil)
    }

    @Test("titles match the destination, not the tab")
    func titles() {
        #expect(Route.instrument("CDR.WA").topBarTitle() == "CDR.WA")
        #expect(Route.transactions.topBarTitle() == "Transactions")
        #expect(Route.dividends(nil).topBarTitle() == "Dividends")
        // The ticker page links here narrowed to one stock, and the bar has to
        // say which — a back chevron reading "Dividends" over a filtered list
        // would misdescribe what is on screen.
        #expect(Route.dividends("AAPL").topBarTitle() == "AAPL dividends")
        #expect(Route.analytics.topBarTitle() == "Analytics")
        #expect(Route.news(nil).topBarTitle() == "News")
        #expect(Route.news("AAPL").topBarTitle() == "AAPL news")
        #expect(Route.newsArticle("1").topBarTitle() == "Story")
        #expect(Route.optionContract("missing").topBarTitle() == "Contract")
        // A market tile's screen is titled as the tile is.
        #expect(Route.marketDetail(.spy).topBarTitle() == "S&P 500")
        #expect(Route.marketDetail(.usdpln).topBarTitle() == "USD/PLN")
    }

    @Test("an option card shortens to underlying, strike and C/P")
    func optionTitle() {
        #expect(Route.optionTitle(underlying: "AAPL", strikeLabel: "180", type: .call) == "AAPL 180 C")
        #expect(Route.optionTitle(underlying: "AAPL", strikeLabel: "180", type: .put) == "AAPL 180 P")
        #expect(Route.optionContract("missing").topBarTitle() == "Contract")
    }

    @Test("the plus labels name the action, not the glyph")
    func addLabels() {
        #expect(TopBarAdd.watchlist.accessibilityLabel == "Watch a stock")
        #expect(TopBarAdd.transaction.accessibilityLabel == "Add a transaction")
    }
}

@Suite("Top bar edit")
struct TopBarEditTests {
    @Test("the watchlist root with tiles is the one place Edit appears")
    func editOnWatchlistRoot() {
        #expect(TopBarEdit.current(tab: .watchlist, destination: nil, hasItems: true) == .watchlist)
    }

    @Test("an empty grid gets no Edit — there is nothing to edit")
    func noEditOverEmptyGrid() {
        #expect(TopBarEdit.current(tab: .watchlist, destination: nil, hasItems: false) == nil)
    }

    @Test("a pushed screen never shows Edit — edit mode is a root-screen state")
    func noEditWhenPushed() {
        #expect(TopBarEdit.current(tab: .watchlist, destination: .instrument("AAPL"), hasItems: true) == nil)
        #expect(TopBarEdit.current(tab: .watchlist, destination: .news(nil), hasItems: true) == nil)
    }

    @Test("no other tab shows Edit, tiles or not")
    func noEditOnOtherTabs() {
        for tab in AppTab.allCases where tab != .watchlist {
            #expect(TopBarEdit.current(tab: tab, destination: nil, hasItems: true) == nil)
            #expect(TopBarEdit.current(tab: tab, destination: nil, hasItems: false) == nil)
        }
    }

    @Test("the label names the action, not the glyph")
    func editLabel() {
        #expect(TopBarEdit.watchlist.accessibilityLabel == "Edit watchlist")
    }
}
