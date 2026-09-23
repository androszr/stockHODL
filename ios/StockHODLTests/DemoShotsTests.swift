import SwiftUI
import UIKit
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

        func show<V: View>(_ view: V, named file: String, scroll: CGFloat = 0) throws {
            let window = UIWindow(windowScene: scene)
            window.frame = scene.screen.bounds
            window.overrideUserInterfaceStyle = .dark
            let rooted = view
                .environment(\.colorScheme, .dark)
                .environment(\.logoLoader, logos)
            window.rootViewController = UIHostingController(rootView: rooted)
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            RunLoop.main.run(until: Date().addingTimeInterval(1.1))
            if scroll > 0 {
                scrollDown(window, points: scroll)
                RunLoop.main.run(until: Date().addingTimeInterval(0.35))
            }
            try write(window, to: out.appendingPathComponent(file))
        }

        try show(world.shell(tab: .dashboard, mode: .brand) { world.dashboard }, named: "dashboard.png")
        try show(world.shell(tab: .holdings, mode: .brand, add: .transaction) { world.holdings }, named: "holdings.png")
        try show(world.shell(tab: .holdings, mode: .pushed("AAPL")) { world.instrument }, named: "instrument.png")
        try show(world.shell(tab: .options, mode: .brand, add: .option) { world.options }, named: "options.png")
        try show(world.shell(tab: .holdings, mode: .pushed("Day report")) { world.dayReport }, named: "day-report.png")
        // Far enough that the written account and the movers are on screen.
        try show(world.shell(tab: .holdings, mode: .pushed("Day report")) { world.dayReport }, named: "day-report-story.png", scroll: 760)
        try renderWidgets(to: out.appendingPathComponent("widgets.png"))
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
    }

    func load() async throws {
        await live.start()
        await optionsStore.start()
        await marketStrip.start()
        chart.loadIfNeeded()
        await instrumentStore.load()
        await dayReportStore.load(day: "2026-09-22", kind: .close)
        await history.load()
        await until { chart.state == .ready && instrumentStore.seriesState == .ready }
        XCTAssertNotNil(live.bootstrap, server.unexpected.joined(separator: ", "))
        XCTAssertEqual(live.tiles.count, 8)
        XCTAssertFalse(marketStrip.tiles.isEmpty)
        XCTAssertNotNil(dayReportStore.view)
        XCTAssertEqual(optionsStore.visibleItems.count, 2)
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
        InstrumentView(store: instrumentStore)
    }

    var options: some View {
        OptionsView(store: optionsStore, imports: nil, isAdding: .constant(false)) { _ in
            fatalError("The demo pictures do not open the add sheet.")
        }
    }

    var dayReport: some View {
        DayReportView(store: dayReportStore, day: "2026-09-22", kind: .close)
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
                    Group {
                        if item == tab { content() } else { Color(Tokens.surface0) }
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
        default: return nil
        }
    }
}
