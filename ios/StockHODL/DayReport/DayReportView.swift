import SwiftUI

struct DayReportView: View {
    let store: DayReportStore
    let day: String?
    let kind: DayReportKind

    @State private var moverTab = 0

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()
            content
        }
        .task(id: "\(day ?? "latest")-\(kind.rawValue)") {
            await store.load(day: day, kind: kind)
        }
    }

    @ViewBuilder private var content: some View {
        if store.isLoading, store.view == nil {
            ProgressView().tint(Color(Tokens.textMuted))
        } else if let message = store.errorMessage, store.view == nil {
            LoadFailureView(message: message, isOffline: !store.stale.isConnected) {
                Task { await store.reload() }
            }
        } else if let view = store.view {
            loaded(view)
        }
    }

    private func loaded(_ view: DayReportResponse) -> some View {
        VStack(spacing: 0) {
            StaleBar(freshness: store.freshness)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    dayHeader(view)
                    kindPicker
                    // One report for everything the owner holds — no
                    // per-portfolio variant, by request (2026-09-21).

                    if store.selectedKind == .close, view.segments.close == .marketOpen {
                        notice("Market still open — report after the close")
                    } else if store.selectedKind == .close, view.segments.close == .notReady {
                        notice("Figures not in yet")
                    } else if store.selectedKind == .morning {
                        morningCard(view)
                    } else {
                        closeCard(view)
                    }

                    if store.selectedKind == .close, view.segments.close == .ready {
                        chart(view)
                        moverSection(view)
                    }
                    marketContext(view)
                    // Headlines are deliberately not shown: they are the
                    // writer's source material, folded into the narrative.
                    events(view)
                    NarrativeSection(narrative: view.narrative)
                }
                .padding(16)
            }
            .refreshable { await store.reload() }
        }
    }

    private func dayHeader(_ view: DayReportResponse) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack {
                Text(view.dayLabel).font(.title3.weight(.semibold))
                Spacer()
                arrows(view)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(view.dayLabel).font(.title3.weight(.semibold))
                arrows(view)
            }
        }
    }

    private func arrows(_ view: DayReportResponse) -> some View {
        HStack(spacing: 8) {
            Button { Task { await store.stepPrev() } } label: {
                Image(systemName: "chevron.left").frame(width: 44, height: 44)
            }
            .disabled(view.prevDay == nil)
            .accessibilityLabel("Previous trading day")
            Button { Task { await store.stepNext() } } label: {
                Image(systemName: "chevron.right").frame(width: 44, height: 44)
            }
            .disabled(view.nextDay == nil)
            .accessibilityLabel("Next trading day")
        }
        .foregroundStyle(Color(Tokens.accent))
    }

    private var kindPicker: some View {
        Picker(
            "Report half",
            selection: Binding(
                get: { store.selectedKind },
                set: { picked in Task { await store.selectKind(picked) } }
            )
        ) {
            Text("Morning").tag(DayReportKind.morning)
            Text("Close").tag(DayReportKind.close)
        }
        .pickerStyle(.segmented)
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Color(Tokens.textSecondary))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 14))
    }

    private func morningCard(_ view: DayReportResponse) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Yesterday's close").font(.caption).foregroundStyle(Color(Tokens.textMuted))
            if let recap = view.recap {
                Text(recap.dayChange.text)
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color(recap.dayChange.direction.token))
                if let pct = recap.dayChangePct { Text(pct).font(.subheadline.monospacedDigit()) }
            } else {
                Text("No closing recap available").foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .cardStyle()
    }

    private func closeCard(_ view: DayReportResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let value = view.figures.valueAtClose {
                Text(value).font(.caption).foregroundStyle(Color(Tokens.textMuted))
            }
            if let change = view.figures.dayChange {
                Text(Self.headline(change.text, partial: view.figures.partial))
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color(change.direction.token))
                if let pct = view.figures.dayChangePct { Text(pct).font(.subheadline.monospacedDigit()) }
            }
            if let holdings = view.figures.holdings?.dayChange {
                Text("Holdings \(holdings.text) \(view.figures.holdings?.dayChangePct ?? "")")
                    .font(.subheadline.monospacedDigit())
            }
            if let options = view.figures.options?.dayChange {
                Text("Options \(options.text) \(view.figures.options?.dayChangePct ?? "") \(view.figures.optionsDayChangeUSD ?? "")")
                    .font(.subheadline.monospacedDigit())
            }
            if let note = view.figures.optionsNote {
                Text(note).font(.caption).foregroundStyle(Color(Tokens.textMuted))
            }
            let omissions = view.figures.partialSymbols + view.figures.excludedSymbols
            if !omissions.isEmpty {
                Text("Without: \(omissions.joined(separator: ", "))")
                    .font(.caption).foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .cardStyle()
    }

    private func chart(_ view: DayReportResponse) -> some View {
        ValueChart(
            points: view.valueLine.points,
            state: view.valueLine.points.isEmpty ? .empty : .ready,
            granularity: view.valueLine.kind == .intraday ? .intraday : .daily,
            currency: "PLN",
            excludedSymbols: view.valueLine.excludedSymbols,
            partialDays: view.valueLine.partialDays,
            windowLabel: view.valueLine.windowLabel
        )
    }

    private func moverSection(_ view: DayReportResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Biggest movers").font(.headline)
            if view.figures.options != nil {
                Picker("Mover kind", selection: $moverTab) {
                    Text("Holdings").tag(0)
                    Text("Options").tag(1)
                }
                .pickerStyle(.segmented)
            }
            MoverBars(items: Self.usesOptionMovers(moverTab, optionsAvailable: view.figures.options != nil)
                ? optionMovers(view)
                : holdingMovers(view))
        }
        .cardStyle()
    }

    private func holdingMovers(_ view: DayReportResponse) -> [MoverBarItem] {
        view.movers.map {
            MoverBarItem(id: $0.symbol, label: $0.symbol, contribution: $0.contribution.text, direction: $0.contribution.direction, barShare: $0.barShare)
        }
    }

    private func optionMovers(_ view: DayReportResponse) -> [MoverBarItem] {
        view.optionMovers.map {
            MoverBarItem(id: $0.symbol, label: $0.symbol, contribution: $0.contribution.text, direction: $0.contribution.direction, barShare: $0.barShare)
        }
    }

    static func usesOptionMovers(_ selection: Int, optionsAvailable: Bool) -> Bool {
        selection == 1 && optionsAvailable
    }

    private func marketContext(_ view: DayReportResponse) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 8)], spacing: 8) {
            ForEach(view.benchmarks, id: \.proxySymbol) { benchmark in
                contextCell(benchmark.indexName, benchmark.dayPct ?? "—", benchmark.direction, "via \(benchmark.proxySymbol)")
            }
            if let usd = view.usdPln {
                contextCell("USD/PLN", usd.move, usd.direction, usd.rate)
            }
        }
    }

    private func contextCell(_ title: String, _ value: String, _ direction: Direction, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(Color(Tokens.textMuted))
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Color(direction.token))
            Text(caption).font(.caption2).foregroundStyle(Color(Tokens.textMuted))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    /// The Events card is the WRITER's dated list — earnings, central-bank
    /// dates, summits, expiries, ex-dividends found while writing the report
    /// — not the market feed's. Until the report is ready it falls back to
    /// the few dates the feed knows for certain (2026-09-21).
    private func events(_ view: DayReportResponse) -> some View {
        let rows = Self.eventRows(view)
        return VStack(alignment: .leading, spacing: 10) {
            Text("Events").font(.headline)
            if rows.isEmpty {
                Text(view.narrative.status == .pending ? "Collected while the report is written" : "No dated events this week")
                    .foregroundStyle(Color(Tokens.textMuted))
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    // Weekday over the date: a list that runs past this week
                    // ("Thu" can be the 24th or the 1st) is only readable
                    // with the day of the month beside the weekday.
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.when)
                            .font(.caption.monospacedDigit())
                        if let date = row.date {
                            Text(date)
                                .font(.caption2.monospacedDigit())
                        }
                    }
                    .foregroundStyle(Color(Tokens.textMuted))
                    .frame(width: 52, alignment: .leading)
                    Text(row.text).font(.subheadline)
                }
            }
        }
        .cardStyle()
    }

    struct EventRow: Equatable {
        /// The weekday ("Wed"), or "Today" for the report's day.
        let when: String
        /// The day of the month ("24 Sep"); nil under "Today", which needs none.
        let date: String?
        let text: String
    }

    /// Writer's events when the report is ready, else the feed's own items.
    static func eventRows(_ view: DayReportResponse) -> [EventRow] {
        if !view.narrative.events.isEmpty {
            return view.narrative.events.map { event in
                EventRow(
                    when: weekdayLabel(event.date, today: view.day),
                    date: dateLabel(event.date, today: view.day),
                    text: event.symbol.map { "\($0) · \(event.title)" } ?? event.title
                )
            }
        }
        return view.events.items.map { event in
            EventRow(
                when: weekdayLabel(event.date, today: view.day),
                date: dateLabel(event.date, today: view.day),
                text: "\(event.symbol) · \(event.detail)"
            )
        }
    }

    private static let isoDayParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let weekdayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "EEE"
        return formatter
    }()

    private static let dayOfMonthFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "d MMM"
        return formatter
    }()

    static func weekdayLabel(_ isoDay: String, today: String) -> String {
        if isoDay == today { return "Today" }
        guard let date = isoDayParser.date(from: isoDay) else { return isoDay }
        return weekdayFormatter.string(from: date)
    }

    /// "24 Sep" for any day but the report's own, and nil when the ISO day
    /// does not parse — the weekday column already shows the raw string then.
    static func dateLabel(_ isoDay: String, today: String) -> String? {
        if isoDay == today { return nil }
        guard let date = isoDayParser.date(from: isoDay) else { return nil }
        return dayOfMonthFormatter.string(from: date)
    }

    static func headline(_ text: String, partial: Bool) -> String {
        partial ? "At least \(text)" : text
    }
}

private extension View {
    func cardStyle() -> some View {
        self
            .padding(16)
            .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 14))
    }
}
