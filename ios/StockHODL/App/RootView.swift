import SwiftUI

/// Everywhere the app can PUSH to.
///
/// An enum rather than a bare `String` destination: two screens keyed on the
/// same type is how a portfolio named "transactions" would one day open the
/// wrong screen, and the compiler cannot warn about that.
///
/// Watchlist and Profile are not here any more — the first is a tab and the
/// second is a sheet off the top bar, so neither is a push.
enum Route: Hashable, Sendable {
    case instrument(String)
    case transactions
    /// One tracked option contract, by its CARD key — the value the payload
    /// already carries. The card is then found inside the payload the tab has
    /// loaded, never fetched by this string, which is what keeps it from
    /// being an oracle for whether a contract exists.
    case optionContract(String)
    /// Every dividend the ledger has recorded, optionally narrowed to one of
    /// the user's own symbols (the web's `/dividends?symbol=`). Reached from
    /// Holdings and from a stock's own page — all four tab slots are taken and
    /// the web has the same four. The narrowing is re-validated server-side; a
    /// stale value silently widens to the full ledger rather than erroring.
    case dividends(String?)
    /// Returns, benchmark and allocation — the phone's half of `/analytics`.
    /// Reached from the Holdings summary, so the four-slot bar stays a
    /// mirror of the web `NAV`. Scope is re-resolved server-side; a stale
    /// chip silently widens to All rather than erroring.
    case analytics
    case dayReport(day: String?, kind: DayReportKind)
    /// The fuller news list, optionally narrowed to one of the user's own
    /// symbols. The narrowing is re-validated server-side; a stale value here
    /// silently widens to the unfiltered feed rather than erroring.
    case news(String?)
    case newsArticle(String)
    /// The read-only screen behind one market tile — S&P 500, Nasdaq, Dow or
    /// USD/PLN. Keyed on the CLOSED enum the payload carries, so there is no
    /// string here that could name a symbol the strip does not show.
    case marketDetail(MarketTileKey)
}

/// Which screen the app is on, decided by session state and nothing else.
struct RootView: View {
    @State private var store = AuthStore.live()

    var body: some View {
        Group {
            switch store.state {
            case .checking:
                // No spinner. The stored-token check is one request and a
                // flash of "loading" that resolves in 200ms reads as a
                // glitch, not as progress.
                Color(Tokens.surface0).ignoresSafeArea()

            case .signedOut, .signingIn:
                SignInView(store: store)

            case let .signedIn(user):
                SignedInView(auth: store, user: user)
            }
        }
        .task { await store.restore() }
        // A cold or backgrounded launch via the private URL scheme
        // (`stockhodl://ticker/AAPL` or `stockhodl://dashboard`) — the same
        // targets a notification tap reaches through `AppDelegate` +
        // `PushCoordinator`. Handled here so it works even before
        // `SignedInView` exists yet.
        .onOpenURL { url in
            guard let destination = PushDeepLink.destination(from: url) else { return }
            PushCoordinator.shared.pendingDestination = destination
        }
    }
}

/// The signed-in shell: top bar, tabs, and the stacks underneath them.
///
/// The frame is the web app's frame — `TopBar` above, four tabs below, the
/// content between (`src/components/shell/app-shell.tsx`). An earlier version
/// of this file argued a tab bar was not worth 49 points of screen to reach
/// two screens a user opens weekly. That was true of a two-screen app; it
/// stopped being true once the phone grew the same four destinations the web
/// has, and a native app whose map disagrees with the web app's map is worse
/// than one that spends the points.
///
/// The `LiveStore` is built here, and its identity is tied to the signed-in
/// user: signing out and back in gets a new store rather than one holding the
/// previous account's rows. `purge()` on sign-out does the same job for the
/// on-disk snapshot, and both are needed — one clears memory, the other clears
/// the App Group container a widget could read.
///
/// The WATCHLIST store is built here too, and for one specific reason: it owns
/// a stream, and a store created inside the tab's body would be rebuilt —
/// reconnecting — every time the tab is selected. Holdings and the watchlist
/// are the only two screens with a live pump, and both outlive navigation.
struct SignedInView: View {
    let auth: AuthStore
    let user: SessionUser

    /// The one place the app learns it came back. It used to live in
    /// `HoldingsView`, `WatchlistView` and `OptionsView` — which meant a
    /// return to the foreground refreshed nothing unless the tab that owned
    /// the wiring happened to be the one on screen, and left the Dashboard
    /// (which draws `LiveStore` but never touched it) showing whatever it had
    /// when the phone was locked. Attached to a debugger the app never really
    /// backgrounds, so this was invisible on the cable and constant off it.
    @Environment(\.scenePhase) private var scenePhase

    /// The other thing that decides when the app may ask for data.
    ///
    /// It sits beside `scenePhase` deliberately: they are the same kind of
    /// fact — an external condition that turns the pumps on and off — and they
    /// are fanned out through the same one function below. Owning it here, in
    /// the shell, is the reason it works at all: wiring it per screen would
    /// mean the network coming back refreshed only whichever tab happened to
    /// be visible, which is exactly the bug `scenePhase` had before it was
    /// lifted out of the three views that each had a copy.
    @State private var reachability = Reachability.shared

    @State private var tab: AppTab = .dashboard
    @State private var isShowingProfile = false
    /// One path per tab, lifted so the bar ABOVE the `TabView` can see
    /// whether the selected tab has pushed — a path owned by the stack
    /// itself would leave the bar stuck on the brand.
    @State private var paths: [AppTab: [Route]] = Dictionary(
        uniqueKeysWithValues: AppTab.allCases.map { ($0, []) }
    )
    @State private var isAddingWatchlist = false
    /// Watchlist edit mode — badges on every tile. Owned by the shell like
    /// `isAddingWatchlist`, because the Edit/Done toggle lives in the bar
    /// above the `TabView` and the badges live in the tab below it.
    @State private var isEditingWatchlist = false
    @State private var isAddingTransaction = false
    @State private var isAddingOption = false
    @State private var isSearching = false
    @State private var recents = RecentSymbolsStore()

    @State private var live: LiveStore?
    @State private var watchlist: WatchlistStore?
    /// Portfolio management. Built here rather than inside Holdings so a
    /// half-finished rename survives the tab being switched away and back.
    @State private var portfolios: PortfoliosStore?
    /// The Holdings chart. Its own store rather than state inside the screen:
    /// `LiveStore` re-renders on every streamed tick, and a chart that
    /// reloaded with it would refetch a five-year walk once a second.
    @State private var portfolioChart: PortfolioChartStore?
    /// The transaction journal. Hoisted beside the chart it now feeds: the
    /// Holdings chart's trade markers and the Transactions screen must read
    /// ONE list, or a row deleted on that screen would leave a marker behind
    /// on this one.
    @State private var journal: TransactionsStore?
    /// Built here for the same reason the watchlist is: it owns a 60 s poll,
    /// and a store created inside a tab's body would restart that poll every
    /// time the tab was selected.
    @State private var options: OptionsStore?
    /// The Dashboard's market index strip. Built here for the same reason
    /// `options` is — it owns a 60 s poll, and a store created inside the
    /// tab's body would restart that poll every time the tab was selected.
    @State private var marketStrip: MarketStripStore?
    /// One loader for the whole signed-in tree, so a logo fetched for the
    /// holdings card is already decoded when the same ticker appears on the
    /// watchlist or its own page. Per-screen loaders would refetch the same
    /// bytes three times and fade three times.
    @State private var logos: LogoLoader?
    /// Built with the rest so the profile sheet does not construct a store
    /// every time it opens — and so sign-out has one thing to purge, not a
    /// store that outlives the sheet holding the previous account's devices.
    @State private var passkeys: PasskeysStore?
    /// Built with the rest so the settings push does not construct a store on
    /// every open — and so sign-out has one thing to purge.
    @State private var settings: SettingsStore?
    /// The "Price alerts" toggle's data layer. Built here for the same
    /// reason `settings` is, and observed against `PushCoordinator` below so
    /// a device token or a notification tap reaches it regardless of which
    /// tab or sheet is on screen when it arrives.
    @State private var notifications: NotificationsStore?
    /// Read-only screens, built here rather than per-push so returning to one
    /// shows what it already had instead of a spinner. None of them owns a pump.
    @State private var dividends: DividendsStore?
    @State private var analytics: AnalyticsStore?
    @State private var dayReport: DayReportStore?
    /// The Dashboard's "Day reports" list. Hoisted like the rest so the list
    /// survives a tab switch; page one is disk-cached for an offline launch.
    @State private var dayReportHistory: DayReportHistoryStore?
    @State private var news: NewsStore?
    /// Owned above the forms because BOTH of them import — a store per sheet
    /// would lose the in-flight read when a sheet re-rendered.
    @State private var imports: ImportStore?
    /// The screens whose store depends on the ROUTE and so cannot be hoisted
    /// into a single `@State` — one instrument store per ticker.
    /// Built once per key and handed back on every re-evaluation of the
    /// `navigationDestination` closure; see `RouteStores` for why that
    /// matters. It is not `@Observable`, so it never re-renders this view.
    @State private var routeStores = RouteStores()

    var body: some View {
        VStack(spacing: 0) {
            TopBar(
                mode: topBarMode,
                add: TopBarAdd.current(tab: tab, destination: currentDestination),
                edit: TopBarEdit.current(
                    tab: tab,
                    destination: currentDestination,
                    hasItems: watchlist?.items.isEmpty == false
                ),
                isEditing: isEditingWatchlist,
                onBack: popCurrent,
                onAdd: performAdd,
                onToggleEdit: { isEditingWatchlist.toggle() },
                onSearch: { isSearching = true },
                onProfile: { isShowingProfile = true }
            )
            .zIndex(1)

            TabView(selection: $tab) {
                ForEach(AppTab.allCases, id: \.self) { item in
                    tabStack(item)
                        .tabItem { Label(item.title, systemImage: item.systemImage) }
                        .tag(item)
                }
            }
            .tint(Color(Tokens.accent))
            .modifier(HardTopScrollEdge())
        }
        .background(Color(Tokens.surface0))
        // The tab bar handles the bottom inset on its own. The top cap is
        // the `TopBar` fill, which ignores the top safe area so it paints
        // into the island the way the web bar paints into
        // `env(safe-area-inset-top)`.
        .ignoresSafeArea(.container, edges: .bottom)
        .onChange(of: currentDestination) { _, dest in
            // The add binding outlives the journal: popping while the sheet
            // is up would otherwise reopen it the next time the route is
            // pushed.
            if dest != .transactions { isAddingTransaction = false }
            // Edit mode is a root-screen state — a stale `true` would flash
            // badges the moment the user popped back to the grid.
            if dest != nil { isEditingWatchlist = false }
        }
        .onChange(of: tab) { _, _ in
            // Same reason as the push above: leaving the screen ends the mode,
            // so returning shows the normal grid rather than yesterday's edit.
            isEditingWatchlist = false
        }
        // The edge that used to have nobody listening. A phone regaining
        // signal now reloads every started store within a frame, instead of
        // waiting for the user to background the app or pull to refresh.
        .onChange(of: reachability.isConnected) { _, connected in
            connectivityChanged(to: connected)
        }
        .onChange(of: scenePhase) { _, phase in
            // `.inactive` is the app switcher and a passing notification
            // banner, not a departure — tearing the streams down for it would
            // reconnect constantly.
            switch phase {
            case .active: sceneChanged(toActive: true)
            case .background: sceneChanged(toActive: false)
            default: break
            }
        }
        .sheet(isPresented: $isShowingProfile) { profileSheet }
        .sheet(isPresented: $isSearching) {
            SymbolSearchSheet(
                form: TransactionFormStore.live(editing: nil, auth: auth),
                recents: recents,
                onOpen: { symbol in paths[tab, default: []].append(.instrument(symbol)) },
                onWatch: { match in Task { await watchlist?.add(match) } },
                isWatched: { symbol in watchlist?.items.contains { $0.symbol == symbol } == true }
            )
        }
        // The device token can arrive at any moment after `enable()` returns
        // — `NotificationsStore` finishes its own registration once it does.
        .onChange(of: PushCoordinator.shared.deviceToken) { _, token in
            guard let token else { return }
            Task { await notifications?.tokenReceived(token) }
        }
        // A tapped notification (or a cold launch via the URL scheme,
        // forwarded here from `RootView`). Switching tabs is deliberate: a
        // price alert is about a stock, and Holdings is where every stock
        // page lives; the daily summary is about the whole portfolio, and the
        // Dashboard is where that lives — regardless of which tab the user
        // was last on.
        .onChange(of: PushCoordinator.shared.pendingDestination) { _, destination in
            guard let destination else { return }
            switch destination {
            case let .ticker(symbol):
                tab = .holdings
                paths[.holdings] = [.instrument(symbol)]
            case .dashboard:
                tab = .dashboard
                paths[.dashboard] = []
            case let .dayReport(day, kind):
                tab = .holdings
                paths[.holdings] = [.dayReport(day: day, kind: kind)]
            }
            PushCoordinator.shared.pendingDestination = nil
        }
        // Environment rather than a constructor argument: a tile three screens
        // down needs it, and threading it through every view in between would
        // put the auth store back into files that are currently testable
        // without one.
        .environment(\.logoLoader, logos ?? NoLogoLoader())
        .task(id: user.id) {
            // Before any store is built: the first path update decides whether
            // the very first refresh is even attempted, and `start()` is
            // idempotent.
            reachability.start()
            if live == nil { live = LiveStore.live(auth: auth) }
            if watchlist == nil { watchlist = WatchlistStore.live(auth: auth) }
            if portfolios == nil { portfolios = PortfoliosStore.live(auth: auth) }
            if portfolioChart == nil { portfolioChart = PortfolioChartStore.live(auth: auth) }
            if journal == nil { journal = TransactionsStore.live(auth: auth) }
            if options == nil { options = OptionsStore.live(auth: auth) }
            if marketStrip == nil { marketStrip = MarketStripStore.live(auth: auth) }
            if logos == nil { logos = LogoLoader.live(auth: auth) }
            if passkeys == nil { passkeys = PasskeysStore.live(auth: auth) }
            if settings == nil { settings = SettingsStore.live(auth: auth) }
            if notifications == nil { notifications = NotificationsStore.live(auth: auth) }
            if dividends == nil { dividends = DividendsStore.live(auth: auth) }
            if analytics == nil { analytics = AnalyticsStore.live(auth: auth) }
            if dayReport == nil { dayReport = DayReportStore.live(auth: auth) }
            if dayReportHistory == nil { dayReportHistory = DayReportHistoryStore.live(auth: auth) }
            if news == nil { news = NewsStore.live(auth: auth) }
            if imports == nil { imports = ImportStore.live(auth: auth) }

            // Holdings data is started HERE rather than by the Holdings tab:
            // the Dashboard reads the same store and would otherwise open on
            // an empty screen if it were ever the first tab shown. The other
            // tabs start themselves when opened, and each store ignores a
            // scene change until it has — see `hasStarted`.
            await live?.start()
        }
    }

    /// Foreground and background, forwarded to every store that owns a live
    /// cadence. Each one decides for itself whether it has anything to resume.
    private func sceneChanged(toActive active: Bool) {
        live?.scenePhaseChanged(toActive: active)
        watchlist?.scenePhaseChanged(toActive: active)
        options?.scenePhaseChanged(toActive: active)
        marketStrip?.scenePhaseChanged(toActive: active)
    }

    /// The radio, forwarded to every store that fetches. Each one ignores it
    /// until it has been started, the same `hasStarted` gate the scene wiring
    /// uses — a tab the user has never opened must not fetch because a train
    /// left a tunnel.
    private func connectivityChanged(to connected: Bool) {
        live?.connectivityChanged(to: connected)
        watchlist?.connectivityChanged(to: connected)
        options?.connectivityChanged(to: connected)
        marketStrip?.connectivityChanged(to: connected)
    }

    /// One navigation stack PER TAB, which is what makes a tab remember where
    /// it was: pushing a stock from the watchlist and switching to Holdings
    /// leaves the watchlist on that stock, the way every native app behaves.
    /// A single shared stack would drag one tab's detail screen into another.
    ///
    /// Each stack owns every destination, so the screens below can push by
    /// VALUE and stay ignorant of the auth store — which is what keeps them
    /// constructible in a test from fakes alone.
    private func tabStack(_ item: AppTab) -> some View {
        NavigationStack(path: pathBinding(for: item)) {
            screen(for: item)
                .navigationDestination(for: Route.self) {
                    destination(for: $0).hidesSystemNav()
                }
                .hidesSystemNav()
        }
        .modifier(HardTopScrollEdge())
    }

    private func pathBinding(for item: AppTab) -> Binding<[Route]> {
        Binding(
            get: { paths[item] ?? [] },
            set: { paths[item] = $0 }
        )
    }

    private var currentDestination: Route? { paths[tab]?.last }

    private var topBarMode: TopBarMode {
        guard let destination = currentDestination else { return .brand }
        let card: OptionCardItem?
        if case let .optionContract(key) = destination {
            card = options?.card(forKey: key)
        } else {
            card = nil
        }
        return .pushed(destination.topBarTitle(optionCard: card))
    }

    private func popCurrent() {
        guard var path = paths[tab], !path.isEmpty else { return }
        path.removeLast()
        paths[tab] = path
    }

    private func performAdd() {
        switch TopBarAdd.current(tab: tab, destination: currentDestination) {
        case .watchlist: isAddingWatchlist = true
        case .transaction: isAddingTransaction = true
        case .option: isAddingOption = true
        case nil: break
        }
    }

    @ViewBuilder
    private func screen(for item: AppTab) -> some View {
        switch item {
        case .dashboard:
            // The SAME store Holdings reads — see DashboardView. No second
            // stream, no second poll, no request of its own.
            if let live {
                DashboardView(
                    store: live,
                    options: options,
                    marketStrip: marketStrip,
                    dayReportHistory: dayReportHistory
                )
            } else {
                Color(Tokens.surface0)
            }

        case .holdings:
            if let live {
                HoldingsView(
                    store: live,
                    portfolios: portfolios,
                    chart: portfolioChart,
                    journal: journal,
                    isAddingTransaction: $isAddingTransaction,
                    imports: imports,
                    makeTransactionForm: { TransactionFormStore.live(editing: nil, auth: auth) }
                )
            } else {
                Color(Tokens.surface0)
            }

        case .options:
            if let options {
                OptionsView(store: options, imports: imports, isAdding: $isAddingOption) { mode in
                    OptionFormStore.live(mode: mode, auth: auth)
                }
            } else {
                Color(Tokens.surface0)
            }

        case .watchlist:
            if let watchlist {
                WatchlistView(
                    store: watchlist,
                    isAdding: $isAddingWatchlist,
                    isEditing: $isEditingWatchlist,
                    makeForm: { TransactionFormStore.live(editing: nil, auth: auth) },
                    // Search now leads to the stock rather than straight onto
                    // the watchlist: the instrument screen answers for any
                    // symbol the directory knows, so looking no longer costs a
                    // watchlist row.
                    onOpen: { symbol in paths[.watchlist, default: []].append(.instrument(symbol)) },
                    recents: recents
                )
            } else {
                Color(Tokens.surface0)
            }
        }
    }

    @ViewBuilder
    private func destination(for route: Route) -> some View {
        switch route {
        case let .instrument(symbol):
            // A symbol is the whole route: the instrument screen resolves it
            // server-side, scoped to this user, which is also why a stale
            // route cannot leak anything.
            //
            // The store comes from `routeStores`, NOT from a fresh
            // `InstrumentStore.live` here: this closure runs again on every
            // re-evaluation of this view's body, and a new store each time
            // handed the pushed screen an empty one whose `.task` had already
            // fired against its predecessor.
            InstrumentView(
                store: routeStores.instrument(symbol) {
                    InstrumentStore.live(
                        symbol: symbol,
                        auth: auth,
                        // The row the user tapped came out of `LiveStore`, so
                        // the app already holds this stock's name and price —
                        // see `InstrumentSeed` for why that is a header and
                        // not a fabricated payload.
                        seed: live?.seed(for: symbol)
                    )
                },
                // The hoisted journal, so a trade added here refreshes the rows
                // the Holdings chart marks — one journal, one truth.
                journal: journal
            ) {
                TransactionFormStore.live(editing: nil, auth: auth)
            }

        case .transactions:
            // The hoisted journal, never a fresh one: the Holdings chart's
            // markers read the same rows, and a second instance would leave a
            // marker on the chart for a row deleted here.
            if let journal {
                TransactionsView(
                    store: journal,
                    imports: imports,
                    isAdding: $isAddingTransaction
                ) { row in
                    TransactionFormStore.live(editing: row, auth: auth)
                }
            } else {
                pending
            }

        // The four routes below read a store this view hoists. A nil store is
        // the split second before `.task(id:)` has built them, and an
        // `if let` alone would push an EMPTY VIEW — a screen with nothing on
        // it and no way to make it load except going back. `pending` paints
        // the surface instead, so the worst case is a blank-but-alive screen
        // rather than a hole.
        case let .optionContract(key):
            if let options {
                OptionContractView(store: options, cardKey: key, imports: imports) { mode in
                    OptionFormStore.live(mode: mode, auth: auth)
                }
            } else {
                pending
            }

        case let .dividends(ticker):
            if let dividends {
                DividendsView(store: dividends, symbol: ticker) { payment in
                    DividendFormStore.live(editing: payment, auth: auth)
                }
            } else {
                pending
            }

        case .analytics:
            if let analytics {
                AnalyticsView(store: analytics)
            } else {
                pending
            }

        // The `case dayReport` route retains the notification's exact day and half.
        case let .dayReport(day, kind):
            if let dayReport {
                DayReportView(store: dayReport, day: day, kind: kind)
            } else {
                pending
            }

        case let .news(ticker):
            if let news {
                NewsView(store: news, ticker: ticker)
            } else {
                pending
            }

        case let .newsArticle(id):
            if let news {
                NewsArticleView(store: news, id: id)
            } else {
                pending
            }

        case let .marketDetail(key):
            // Memoised like the instrument store, for the same reason: this
            // closure re-runs on every re-evaluation of this body, and a
            // fresh store each time would hand the pushed screen an empty
            // one whose `.task` had already fired against its predecessor.
            // The header reads the SAME strip store the Dashboard polls.
            MarketDetailView(
                store: routeStores.marketDetail(key) {
                    MarketDetailStore.live(key: key, auth: auth)
                },
                strip: marketStrip
            )
        }
    }

    /// A destination whose store has not been built yet.
    private var pending: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            ProgressView().tint(Color(Tokens.textMuted))
        }
    }

    private var profileSheet: some View {
        NavigationStack {
            ProfileView(
                user: user,
                appVersion: Bundle.main.displayVersion,
                apiHost: AppConfig.current.baseURL.host() ?? "—",
                passkeys: passkeys,
                settings: settings,
                notifications: notifications
            ) {
                Task {
                    isShowingProfile = false
                    // Purge everything derived from the account BEFORE
                    // revoking: once the token is gone the stores cannot tell
                    // a signed-out state from an unreachable server, and the
                    // snapshot would outlive the session on disk. The push
                    // token is the same story — unregistering needs the
                    // bearer token that `auth.signOut()` is about to revoke.
                    await notifications?.purge()
                    live?.purge()
                    watchlist?.purge()
                    options?.purge()
                    marketStrip?.purge()
                    logos?.purge()
                    passkeys?.purge()
                    settings?.purge()
                    portfolioChart?.purge()
                    journal?.purge()
                    dividends?.purge()
                    analytics?.purge()
                    dayReport?.purge()
                    dayReportHistory?.purge()
                    news?.purge()
                    routeStores.purge()
                    recents.purge()
                    // Every payload cache in one call. The per-store `purge()`
                    // above clears the ones a store still holds a reference
                    // to, but a store built for a route the user has since
                    // popped — one instrument's detail, one ticker's news —
                    // has no live object left to ask. A list of caches to
                    // clear is a list someone forgets to add to; a directory
                    // is not, because the next cache added lands inside it.
                    DiskCache<Snapshot>.clearAll()
                    await auth.signOut()
                }
            }
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.inline)
            .tokenSheetChrome()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isShowingProfile = false }
                }
            }
        }
    }
}
