import SwiftUI
import UIKit
import WidgetKit
import XCTest

@testable import StockHODL

/// The README pictures, drawn by the app's own screens from `DemoBook`.
///
/// `testDemoBookIsSynthetic` always runs. The render runs only when
/// `tools/demo_shots.py` passes `STOCKHODL_DEMO_SHOTS_OUT` (as
/// `TEST_RUNNER_STOCKHODL_DEMO_SHOTS_OUT`) on a throwaway simulator. Every
/// request is answered from the book; nothing is asked of a network.
@MainActor
final class DemoShotsTests: XCTestCase {

    func testDemoBookIsSynthetic() {
        XCTAssertTrue(DemoBook.synthetic)
        XCTAssertEqual(DemoBook.holdings.count, 8)
        XCTAssertEqual(DemoBook.holdings.map(\.symbol), ["AAPL", "MSFT", "NVDA", "AVGO", "COST", "JPM", "XOM", "KO"])
        let blob = DemoBook.auditBlob
        XCTAssertTrue(blob.contains("70"))
        XCTAssertTrue(blob.contains("238,19"))
        for forbidden in Self.privateStrings() {
            XCTAssertFalse(blob.contains(forbidden), "DemoBook carries a line of .private-strings")
        }
    }

    func testWatchlistDemoKeepsTargetGroupingAndNeverInventsPositionProfit() {
        let sections = WatchlistSections.build(items: DemoBook.watchedItems, live: DemoBook.watchlistPayload)
        XCTAssertEqual(sections.map(\.title), ["Near a target", "No target"])
        XCTAssertEqual(sections.flatMap(\.items).map(\.symbol), ["EXM", "NEM"])
        XCTAssertEqual(DemoBook.watchlistPayload.items.first?.target?.sentence,
                       "Needs to rise 1,24% to reach your 125,00 USD line")
    }

    /// The real figures the book must never carry, read from the git-ignored
    /// `.private-strings` at the repository root so the list is not published
    /// with the test. A simulator test reads the host's disk, so `#filePath`
    /// reaches it; a fresh clone has no such file and checks nothing here.
    private static func privateStrings(file: String = #filePath) -> [String] {
        let root = URL(fileURLWithPath: file)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        guard let text = try? String(contentsOf: root.appendingPathComponent(".private-strings"), encoding: .utf8) else {
            return []
        }
        return text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
    }

    func testRenderDemoShots() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let outPath = env["STOCKHODL_DEMO_SHOTS_OUT"], !outPath.isEmpty else {
            throw XCTSkip("Set STOCKHODL_DEMO_SHOTS_OUT (tools/demo_shots.py) to render.")
        }
        let out = URL(fileURLWithPath: outPath, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

        let world = DemoWorld()
        try await world.load()
        let logos = DemoLogos.load()
        XCTAssertEqual(logos.count, 8, "The eight company logos did not load.")

        AppChrome.apply()
        UIView.setAnimationsEnabled(false)

        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        XCTAssertLessThanOrEqual(scene.screen.bounds.width, 430, "Use an iPhone simulator, not an iPad.")

        func show<V: View>(
            _ view: V, named file: String, scroll: CGFloat = 0,
            scheme: ColorScheme = .dark, width: CGFloat? = nil,
            typeSize: DynamicTypeSize = .large
        ) throws {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width ?? scene.screen.bounds.width, height: scene.screen.bounds.height)
            window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
            let rooted = view
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, typeSize)
                .environment(\.logoLoader, logos)
            window.rootViewController = UIHostingController(rootView: rooted)
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            RunLoop.main.run(until: Date().addingTimeInterval(1.1))
            if scroll > 0 {
                // A lazy stack reports only the height it has laid out so far,
                // so one jump stops short; each pass lays out more of it.
                for _ in 0..<4 {
                    scrollDown(window, points: scroll)
                    RunLoop.main.run(until: Date().addingTimeInterval(0.35))
                }
            }
            try write(window, to: out.appendingPathComponent(file))
        }

        try show(world.shell(tab: .dashboard, mode: .brand) { world.dashboard }, named: "dashboard.png")
        // The holdings grid, then the options grid under it.
        try show(world.shell(tab: .dashboard, mode: .brand) { world.dashboard }, named: "dashboard-grid.png", scroll: 560)
        try show(world.shell(tab: .dashboard, mode: .brand) { world.dashboard }, named: "dashboard-options.png", scroll: 1100)
        try show(world.shell(tab: .holdings, mode: .brand, add: .transaction) { world.holdings }, named: "holdings.png")
        try show(ScrollView {
            PortfolioChartSection(store: world.chart, initiallyExpanded: true)
                .padding(QuietDesign.Space.page)
        }.background(Color(Tokens.surface0)), named: "holdings-chart-expanded.png")
        try show(world.shell(tab: .holdings, mode: .pushed("AAPL")) { world.instrument }, named: "instrument.png")
        try show(world.shell(tab: .options, mode: .brand, add: .option) { world.options }, named: "options.png")
        try show(world.shell(tab: .holdings, mode: .pushed("Day report")) { world.dayReport }, named: "day-report.png")
        // Far enough that the written account and the movers are on screen.
        try show(world.shell(tab: .holdings, mode: .pushed("Day report")) { world.dayReport }, named: "day-report-story.png", scroll: 760)
        try show(world.shell(tab: .watchlist, mode: .brand, add: .watchlist) { world.watchlist }, named: "watchlist.png")
        try show(world.shell(tab: .dashboard, mode: .brand) { world.dashboard }, named: "dashboard-light.png", scheme: .light)
        try show(world.shell(tab: .holdings, mode: .brand, add: .transaction) { world.holdings }, named: "holdings-light.png", scheme: .light)
        try show(world.shell(tab: .holdings, mode: .pushed("AAPL")) { world.instrument }, named: "instrument-light.png", scheme: .light)
        try show(world.shell(tab: .options, mode: .brand, add: .option) { world.options }, named: "options-light.png", scheme: .light)
        try show(world.shell(tab: .watchlist, mode: .brand, add: .watchlist) { world.watchlist }, named: "watchlist-light.png", scheme: .light)
        try show(VStack(spacing: 0) {
            StaleBar(freshness: .stale(since: Date().addingTimeInterval(-7200)))
            QuietDesignCatalog()
        }, named: "catalog-narrow-accessibility.png", width: 375, typeSize: .accessibility2)
        try show(QuietDesignCatalog(), named: "catalog-narrow-row.png", scroll: 900,
                 width: 375, typeSize: .accessibility2)
        try show(QuietDesignCatalog(), named: "catalog-light.png", scheme: .light)
        try renderWidgets(to: out.appendingPathComponent("widgets.png"))
    }

    func testRenderWidgetVariants() throws {
        guard let outPath = ProcessInfo.processInfo.environment["STOCKHODL_WIDGET_SHOTS_OUT"],
              !outPath.isEmpty else {
            throw XCTSkip("Set STOCKHODL_WIDGET_SHOTS_OUT to render fixed-family widget content.")
        }
        let out = URL(fileURLWithPath: outPath, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

        let base = DemoBook.widgetPayload()
        let regular = SummaryEntry(date: Date().addingTimeInterval(-120),
                                   outcome: .figures(base, capturedAt: nil))
        let long = SummaryEntry(date: regular.date,
                                outcome: .figures(Self.longPayload(base), capturedAt: regular.date.addingTimeInterval(-3600)))

        for scheme in [ColorScheme.dark, .light] {
            let suffix = scheme == .dark ? "dark" : "light"
            try captureWidget(SummaryWidgetView(entry: regular, side: .holdings, previewFamily: .systemSmall),
                              named: "widget-holdings-small-\(suffix)", size: CGSize(width: 158, height: 158),
                              scheme: scheme, out: out)
            try captureWidget(SummaryWidgetView(entry: regular, side: .options, previewFamily: .systemMedium),
                              named: "widget-options-medium-\(suffix)", size: CGSize(width: 338, height: 158),
                              scheme: scheme, out: out)
            let combinedSmall = try captureWidget(CombinedSummaryWidgetView(entry: regular, previewFamily: .systemSmall),
                                                  named: "widget-combined-small-\(suffix)", size: CGSize(width: 158, height: 158),
                                                  scheme: scheme, out: out)
            try assertDayLinePlot(in: combinedSmall, named: "widget-combined-small-\(suffix)")
            try captureWidget(CombinedSummaryWidgetView(entry: regular, previewFamily: .systemMedium),
                              named: "widget-combined-medium-\(suffix)", size: CGSize(width: 338, height: 158),
                              scheme: scheme, out: out)
            try captureWidget(SummaryWidgetView(entry: long, side: .holdings, previewFamily: .systemSmall),
                              named: "widget-holdings-small-long-\(suffix)", size: CGSize(width: 158, height: 158),
                              scheme: scheme, out: out)
            try captureWidget(CombinedSummaryWidgetView(entry: long, previewFamily: .systemSmall),
                              named: "widget-combined-small-long-\(suffix)", size: CGSize(width: 158, height: 158),
                              scheme: scheme, out: out)
            let combinedMediumLong = try captureWidget(CombinedSummaryWidgetView(entry: long, previewFamily: .systemMedium),
                                                       named: "widget-combined-medium-long-\(suffix)", size: CGSize(width: 338, height: 158),
                                                       scheme: scheme, out: out)
            try assertDayLinePlot(in: combinedMediumLong, named: "widget-combined-medium-long-\(suffix)")
            try assertHeaderAtTop(in: combinedMediumLong, named: "widget-combined-medium-long-\(suffix)")
            try captureWidget(LockScreenWidgetView(entry: regular, previewFamily: .accessoryRectangular),
                              named: "widget-lock-rect-\(suffix)", size: CGSize(width: 160, height: 72),
                              scheme: scheme, out: out, accessory: true)
            try captureWidget(LockScreenWidgetView(entry: regular, previewFamily: .accessoryInline),
                              named: "widget-lock-inline-\(suffix)", size: CGSize(width: 310, height: 28),
                              scheme: scheme, out: out, accessory: true)
        }
    }

    /// The square combined tile draws its day plot under the two totals. Runs
    /// on every test pass (not only when the README pictures are drawn),
    /// through the same `captureWidget` render the pictures use, written to a
    /// throwaway folder. The Quiet Precision refresh lost this plot with every
    /// gate green; this is the check that was missing.
    func testCombinedSmallWidgetDrawsDayLines() throws {
        let payload = DemoBook.widgetPayload()
        let lines = try XCTUnwrap(payload.dayLines, "the demo widget payload has no day lines to draw")
        XCTAssertFalse(lines.holdings.isEmpty, "the demo day lines carry no holdings series")
        XCTAssertFalse(lines.options.isEmpty, "the demo day lines carry no options series")
        let entry = SummaryEntry(date: Date().addingTimeInterval(-120),
                                 outcome: .figures(payload, capturedAt: nil))
        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("combined-day-lines-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: out) }
        for scheme in [ColorScheme.dark, .light] {
            let name = "widget-combined-small-\(scheme == .dark ? "dark" : "light")"
            let image = try captureWidget(CombinedSummaryWidgetView(entry: entry, previewFamily: .systemSmall),
                                          named: name, size: CGSize(width: 158, height: 158),
                                          scheme: scheme, out: out)
            try assertDayLinePlot(in: image, named: name)
        }
    }

    /// The wide combined tile with long totals: every figure whole, yet the
    /// plot survives (its key yields first), and the header stays pinned to
    /// the top — also when there is no plot and the content is shorter.
    func testCombinedMediumLongKeepsPlotWithHeaderAtTop() throws {
        let payload = Self.longPayload(DemoBook.widgetPayload())
        XCTAssertNotNil(payload.dayLines, "the demo widget payload has no day lines to draw")
        let entry = SummaryEntry(date: Date().addingTimeInterval(-120),
                                 outcome: .figures(payload, capturedAt: nil))
        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("combined-medium-long-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: out) }
        for scheme in [ColorScheme.dark, .light] {
            let name = "widget-combined-medium-long-\(scheme == .dark ? "dark" : "light")"
            let image = try captureWidget(CombinedSummaryWidgetView(entry: entry, previewFamily: .systemMedium),
                                          named: name, size: CGSize(width: 338, height: 158),
                                          scheme: scheme, out: out)
            try assertDayLinePlot(in: image, named: name)
            try assertHeaderAtTop(in: image, named: name)

            // With no plot at all the content is shorter than the tile; the
            // header still starts at the top instead of floating to the middle.
            let bare = WidgetSummaryResponse(dayLines: nil, holdings: payload.holdings,
                                             market: payload.market, options: payload.options)
            let bareName = "\(name)-no-lines"
            let bareImage = try captureWidget(
                CombinedSummaryWidgetView(entry: SummaryEntry(date: entry.date, outcome: .figures(bare, capturedAt: nil)),
                                          previewFamily: .systemMedium),
                named: bareName, size: CGSize(width: 338, height: 158), scheme: scheme, out: out)
            try assertHeaderAtTop(in: bareImage, named: bareName)
        }
    }

    /// The demo payload with totals long enough to wrap on both families.
    private static func longPayload(_ base: WidgetSummaryResponse) -> WidgetSummaryResponse {
        func withValue(_ summary: LiveSummary, _ value: String) -> LiveSummary {
            LiveSummary(dayChange: summary.dayChange, dayChangePct: summary.dayChangePct,
                        excludedSymbols: summary.excludedSymbols,
                        extended: summary.extended,
                        partialDayChange: summary.partialDayChange,
                        totalChange: summary.totalChange, totalChangePct: summary.totalChangePct,
                        totalValue: value, trend: summary.trend)
        }
        return WidgetSummaryResponse(
            dayLines: base.dayLines,
            holdings: withValue(base.holdings, "1 234 567 890,12 PLN"),
            market: base.market,
            options: withValue(base.options, "123 456 789,01 USD")
        )
    }

    /// An RGBA8 sRGB copy of a capture, plus the tile background sampled in
    /// the padding corner — no colour is hard-coded.
    private struct Pixels {
        var bytes: [UInt8]
        var width: Int
        var height: Int
        var background: (Int, Int, Int)

        func offBackground(_ x: Int, _ y: Int) -> Bool {
            let i = (y * width + x) * 4
            let dr = abs(Int(bytes[i]) - background.0)
            let dg = abs(Int(bytes[i + 1]) - background.1)
            let db = abs(Int(bytes[i + 2]) - background.2)
            return max(dr, max(dg, db)) > 24
        }
    }

    private func pixels(of image: UIImage, named name: String,
                        file: StaticString, line: UInt) throws -> Pixels {
        let cg = try XCTUnwrap(image.cgImage, "\(name) has no bitmap", file: file, line: line)
        let width = cg.width
        let height = cg.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        try bytes.withUnsafeMutableBytes { buffer in
            let context = try XCTUnwrap(CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ), file: file, line: line)
            context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        let corner = (3 * width + 3) * 4
        return Pixels(bytes: bytes, width: width, height: height,
                      background: (Int(bytes[corner]), Int(bytes[corner + 1]), Int(bytes[corner + 2])))
    }

    /// The first drawn row sits within the top 15% of the capture: the 12 pt
    /// padding plus a few points, where the header starts when top-pinned.
    /// A vertically centred tile starts its header visibly lower.
    private func assertHeaderAtTop(in image: UIImage, named name: String,
                                   file: StaticString = #filePath, line: UInt = #line) throws {
        let px = try pixels(of: image, named: name, file: file, line: line)
        let first = (0..<px.height).first { y in (0..<px.width).contains { px.offBackground($0, y) } }
        let row = try XCTUnwrap(first, "\(name) drew nothing", file: file, line: line)
        XCTAssertLessThan(row, px.height * 15 / 100,
                          "\(name): the header starts at row \(row) of \(px.height), not at the top",
                          file: file, line: line)
    }

    /// Looks for the plot in the bottom 30% of a combined-tile capture,
    /// against the tile's own background (sampled in the padding corner, so
    /// no colour is hard-coded and live/closed hues do not matter).
    ///
    /// Two signals, both presence rather than colour: enough pixels off the
    /// background, and one row with a long unbroken run of them. The run is
    /// the plot's full-width 0% rule and the strokes; text never draws a
    /// horizontal run half the tile wide, so a tile whose totals merely sit
    /// low in the band (they are vertically centred without a plot) fails.
    private func assertDayLinePlot(in image: UIImage, named name: String,
                                   file: StaticString = #filePath, line: UInt = #line) throws {
        let px = try pixels(of: image, named: name, file: file, line: line)
        let width = px.width
        let height = px.height

        let bandTop = height * 7 / 10
        var count = 0
        var longestRun = 0
        for y in bandTop..<height {
            var run = 0
            for x in 0..<width {
                if px.offBackground(x, y) {
                    count += 1
                    run += 1
                    longestRun = max(longestRun, run)
                } else {
                    run = 0
                }
            }
        }
        XCTAssertGreaterThanOrEqual(count, 40, "\(name): no day-line pixels in the bottom band", file: file, line: line)
        XCTAssertGreaterThanOrEqual(longestRun, width / 2,
                                    "\(name): nothing in the bottom band spans the tile like a day line (longest run \(longestRun) of \(width) px)",
                                    file: file, line: line)
    }

    @discardableResult
    private func captureWidget<V: View>(_ view: V, named name: String, size: CGSize,
                                        scheme: ColorScheme, out: URL, accessory: Bool = false) throws -> UIImage {
        let background = accessory
            ? (scheme == .dark ? Color.black : Color(Tokens.surface2))
            : Color(Tokens.surface0)
        let card = view
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(accessory ? 6 : 12)
            .frame(width: size.width, height: size.height)
            .background(background)
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: card)
        renderer.scale = 3
        renderer.proposedSize = ProposedViewSize(size)
        let image = try XCTUnwrap(renderer.uiImage, "\(name) did not draw")
        try XCTUnwrap(image.pngData()).write(to: out.appendingPathComponent("\(name).png"))
        let points: [String: Double] = ["width_pt": size.width, "height_pt": size.height, "scale": 3]
        try JSONSerialization.data(withJSONObject: points)
            .write(to: out.appendingPathComponent("\(name).json"))
        return image
    }

    /// The longest scroll view in the window, moved down. SwiftUI's scroll
    /// view is a UIScrollView once the window has laid out.
    private func scrollDown(_ window: UIWindow, points: CGFloat) {
        guard let root = window.rootViewController?.view else { return }
        var best: UIScrollView?
        func walk(_ view: UIView) {
            if let scroll = view as? UIScrollView,
               scroll.contentSize.height > scroll.bounds.height + 80,
               best == nil || scroll.contentSize.height > (best?.contentSize.height ?? 0) {
                best = scroll
            }
            view.subviews.forEach(walk)
        }
        walk(root)
        let offset = min(points, max(0, (best?.contentSize.height ?? 0) - (best?.bounds.height ?? 0)))
        best?.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
        best?.layoutIfNeeded()
    }

    private func renderWidgets(to url: URL) throws {
        let board = DemoWidgetBoard(entry: SummaryEntry(
            date: Date().addingTimeInterval(-120),
            outcome: .figures(DemoBook.widgetPayload(), capturedAt: nil)
        ))
        let renderer = ImageRenderer(content: board.environment(\.colorScheme, .dark))
        renderer.scale = 2
        renderer.proposedSize = ProposedViewSize(width: 400, height: nil)
        let image = try XCTUnwrap(renderer.uiImage, "Widget board did not draw.")
        let data = try XCTUnwrap(image.pngData())
        try data.write(to: url)
        let points: [String: Double] = [
            "width_pt": image.size.width,
            "height_pt": image.size.height,
            "scale": 2,
        ]
        try JSONSerialization.data(withJSONObject: points)
            .write(to: url.deletingPathExtension().appendingPathExtension("json"))
    }

    private func write(_ window: UIWindow, to url: URL) throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = window.screen.scale
        format.preferredRange = .standard
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
        let image = renderer.image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let data = try XCTUnwrap(image.pngData())
        try data.write(to: url)
        // Screen geometry, not money: CGFloat bridges to NSNumber as is.
        let points: [String: CGFloat] = [
            "width_pt": window.bounds.width,
            "height_pt": window.bounds.height,
            "scale": window.screen.scale,
        ]
        try JSONSerialization.data(withJSONObject: points)
            .write(to: url.deletingPathExtension().appendingPathExtension("json"))
    }
}

/// One in-memory server and the stores the screens read. Built in the test
/// target so the app itself grows no demo mode.
@MainActor
private final class DemoWorld {
    let server = DemoServer()
    let defaults = UserDefaults(suiteName: "demo.shots.\(UUID().uuidString)")!
    let live: LiveStore
    let optionsStore: OptionsStore
    let marketStrip: MarketStripStore
    let chart: PortfolioChartStore
    let instrumentStore: InstrumentStore
    let dayReportStore: DayReportStore
    let history: DayReportHistoryStore
    let watchlistStore: WatchlistStore
    let recents: RecentSymbolsStore

    init() {
        let api = APIClient(
            config: AppConfig(baseURL: URL(string: "https://example.test")!),
            transport: server.transport()
        )
        let token: @MainActor () -> String? = { "demo.token" }
        let caches = FakePayloadCacheFamily<SeriesPayload>()
        live = LiveStore(
            client: LiveClient(api: api),
            snapshots: DemoSnapshots(),
            tokenProvider: token,
            defaults: defaults
        )
        optionsStore = OptionsStore(
            client: OptionsClient(api: api),
            cache: FakePayloadCache<OptionsPayload>(),
            makeSeriesCache: caches.make(),
            tokenProvider: token,
            defaults: defaults
        )
        marketStrip = MarketStripStore(
            client: MarketStripClient(api: api),
            cache: FakePayloadCache<MarketStripPayload>(),
            tokenProvider: token
        )
        chart = PortfolioChartStore(client: PortfolioSeriesClient(api: api), tokenProvider: token, defaults: defaults)
        let instrumentCaches = FakePayloadCacheFamily<SeriesPayload>()
        instrumentStore = InstrumentStore(
            symbol: "AAPL",
            client: InstrumentClient(api: api),
            cache: FakePayloadCache<InstrumentResponse>(),
            makeSeriesCache: instrumentCaches.make(),
            tokenProvider: token,
            defaults: defaults
        )
        let reports = FakePayloadCacheFamily<DayReportResponse>()
        dayReportStore = DayReportStore(
            client: DayReportClient(api: api),
            makeCache: { key, _ in reports.cache(for: key) },
            tokenProvider: token
        )
        let historyCaches = FakePayloadCacheFamily<DayReportHistoryResponse>()
        history = DayReportHistoryStore(
            client: DayReportClient(api: api),
            makeCache: { key, _ in historyCaches.cache(for: key) },
            tokenProvider: token
        )
        watchlistStore = WatchlistStore(
            client: WatchlistClient(api: api),
            cache: FakePayloadCache<CachedWatchlist>(),
            tokenProvider: token
        )
        recents = RecentSymbolsStore(defaults: defaults)
    }

    func load() async throws {
        await live.start()
        await optionsStore.start()
        await marketStrip.start()
        chart.loadIfNeeded()
        await instrumentStore.load()
        await dayReportStore.load(day: "2026-09-22", kind: .close)
        await history.load()
        await watchlistStore.start()
        await until { chart.state == .ready && instrumentStore.seriesState == .ready }
        XCTAssertNotNil(live.bootstrap, server.unexpected.joined(separator: ", "))
        XCTAssertEqual(live.tiles.count, 8)
        XCTAssertFalse(marketStrip.tiles.isEmpty)
        XCTAssertNotNil(dayReportStore.view)
        XCTAssertEqual(optionsStore.visibleItems.count, 2)
        XCTAssertEqual(watchlistStore.items.count, 2)
    }

    func shell<V: View>(tab: AppTab, mode: TopBarMode, add: TopBarAdd? = nil, @ViewBuilder content: @escaping () -> V) -> some View {
        DemoShell(tab: tab, mode: mode, add: add, content: content)
    }

    var dashboard: some View {
        DashboardView(store: live, options: optionsStore, marketStrip: marketStrip, dayReportHistory: history)
    }

    var holdings: some View {
        HoldingsView(store: live, chart: chart, isAddingTransaction: .constant(false))
    }

    var instrument: some View {
        InstrumentView(store: instrumentStore, makeTransactionForm: {
            fatalError("Demo does not open the transaction form")
        })
    }

    var options: some View {
        OptionsView(store: optionsStore, imports: nil, isAdding: .constant(false)) { _ in
            fatalError("The demo pictures do not open the add sheet.")
        }
    }

    var dayReport: some View {
        DayReportView(store: dayReportStore, day: "2026-09-22", kind: .close)
    }

    var watchlist: some View {
        WatchlistView(
            store: watchlistStore, isAdding: .constant(false), isEditing: .constant(false),
            makeForm: { fatalError("Demo does not open the watch form") },
            onOpen: { _ in }, recents: recents
        )
    }
}

/// The company marks for the tiles. Loaded from `DemoLogos/` (or
/// `STOCKHODL_DEMO_LOGOS`) so a screenshot paints a logo on the first frame
/// instead of the monogram.
final class DemoLogos: LogoLoading {
    let images: [String: UIImage]
    var count: Int { images.count }

    init(images: [String: UIImage]) {
        self.images = images
    }

    func cached(_ symbol: String) -> UIImage? { images[symbol] }
    func image(for symbol: String) async -> UIImage? { cached(symbol) }

    static func load() -> DemoLogos {
        let env = ProcessInfo.processInfo.environment["STOCKHODL_DEMO_LOGOS"]
        let folder = (env?.isEmpty == false)
            ? URL(fileURLWithPath: env!, isDirectory: true)
            : URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("DemoLogos")
        var images: [String: UIImage] = [:]
        for symbol in ["AAPL", "MSFT", "NVDA", "AVGO", "COST", "JPM", "XOM", "KO"] {
            let url = folder.appendingPathComponent("\(symbol).png")
            if let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                images[symbol] = image
            }
        }
        return DemoLogos(images: images)
    }
}

private struct DemoShell<Content: View>: View {
    let tab: AppTab
    let mode: TopBarMode
    var add: TopBarAdd?
    @ViewBuilder var content: () -> Content
    @State private var selection: AppTab

    init(tab: AppTab, mode: TopBarMode, add: TopBarAdd?, @ViewBuilder content: @escaping () -> Content) {
        self.tab = tab
        self.mode = mode
        self.add = add
        self.content = content
        _selection = State(initialValue: tab)
    }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(mode: mode, add: add, onProfile: {})
                .zIndex(1)
            TabView(selection: $selection) {
                ForEach(AppTab.allCases, id: \.self) { item in
                    NavigationStack {
                        Group {
                            if item == tab { content() } else { Color(Tokens.surface0) }
                        }
                        .navigationDestination(for: Route.self) { route in
                            Text(String(describing: route))
                        }
                        .hidesSystemNav()
                    }
                    .tabItem { Label(item.title, systemImage: item.systemImage) }
                    .tag(item)
                }
            }
            .tint(Color(Tokens.accent))
            .modifier(HardTopScrollEdge())
        }
        .background(Color(Tokens.surface0))
        .ignoresSafeArea(.container, edges: .bottom)
    }
}

private struct DemoWidgetBoard: View {
    let entry: SummaryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            tile(SummaryWidgetView(entry: entry, side: .holdings))
            tile(SummaryWidgetView(entry: entry, side: .options))
            // `widgetFamily` is read-only outside a widget process. Unset, it
            // is the medium family, which is the Home Screen tile, and the
            // lock-screen view's non-inline branch, which is the rectangle.
            LockScreenWidgetView(entry: entry)
                .frame(width: 172, height: 72, alignment: .leading)
                .padding(12)
                .background(Color.black, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .padding(20)
        .frame(width: 400, alignment: .topLeading)
        .background(Color(Tokens.surface0))
    }

    private func tile<V: View>(_ view: V) -> some View {
        view
            .frame(width: 360, alignment: .leading)
    }
}

private final class DemoSnapshots: SnapshotStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Snapshot?

    func read() -> Snapshot? { lock.withLock { stored } }
    func write(_ snapshot: Snapshot) { lock.withLock { stored = snapshot } }
    func clear() { lock.withLock { stored = nil } }
}

/// Answers every read from the book. A path it does not know is recorded
/// and refused, so a picture cannot quietly include a live response.
private final class DemoServer: @unchecked Sendable {
    private let lock = NSLock()
    private var missed: [String] = []
    var unexpected: [String] { lock.withLock { missed } }

    func transport() -> APIClient.Transport {
        { [self] request in
            let path = request.url?.path ?? ""
            let body = try self.body(for: path)
            let status = body == nil ? 404 : 200
            if body == nil {
                lock.withLock { missed.append(path) }
            }
            let http = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
            )!
            return (body ?? Data("{}".utf8), http)
        }
    }

    private func body(for path: String) throws -> Data? {
        let encoder = JSONEncoder()
        switch path {
        case "/api/mobile/v1/bootstrap": return try encoder.encode(DemoBook.bootstrap)
        case "/api/mobile/v1/live": return try encoder.encode(DemoBook.livePayload)
        case "/api/mobile/v1/options": return try encoder.encode(DemoBook.optionsPayload)
        case "/api/mobile/v1/series/options": return try encoder.encode(DemoBook.optionsLine)
        case "/api/mobile/v1/market-strip": return try encoder.encode(DemoBook.marketStrip)
        case "/api/mobile/v1/series/portfolio": return try encoder.encode(DemoBook.sessionLine)
        case "/api/mobile/v1/instrument/AAPL": return try encoder.encode(DemoBook.apple)
        case "/api/mobile/v1/series/price/AAPL": return try encoder.encode(DemoBook.appleLine)
        case "/api/mobile/v1/day-report": return try encoder.encode(DemoBook.dayReport)
        case "/api/mobile/v1/day-report/history": return try encoder.encode(DemoBook.dayReportHistory)
        case "/api/mobile/v1/watchlist": return try encoder.encode(WatchlistResponse(items: DemoBook.watchedItems))
        case "/api/mobile/v1/watchlist/quotes": return try encoder.encode(DemoBook.watchlistPayload)
        default: return nil
        }
    }
}
