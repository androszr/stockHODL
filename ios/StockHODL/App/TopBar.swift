import SwiftUI

/// What the persistent top bar shows on the left.
///
/// Brand at a tab root, back-plus-title once that tab has pushed. Kept as
/// data so a test can pin the four cases without mounting SwiftUI.
enum TopBarMode: Equatable, Sendable {
    case brand
    case pushed(String)
}

/// The one extra control the bar is allowed besides Profile.
///
/// Watchlist, the journal, and the Options tab root are the screens whose
/// primary action used to live in a system toolbar — and that toolbar is now
/// hidden, so the action has to live here or it vanishes.
enum TopBarAdd: Equatable, Sendable {
    case watchlist
    case transaction
    case option

    var accessibilityLabel: String {
        switch self {
        case .watchlist: "Watch a stock"
        case .transaction: "Add a transaction"
        case .option: "Add a contract"
        }
    }

    /// Nil on every other combination. A plus on Dashboard would invent an
    /// action that screen does not have. A ticker page HAS its two actions,
    /// but they live in-page (`InstrumentActionButtons`, on the price line):
    /// the watch toggle needs the screen's own watching/not-watching state,
    /// and this bar sits outside every `NavigationStack`, so it could show a
    /// button but never that state.
    ///
    /// Holdings gets `.transaction` too, same as the Transactions push: a
    /// holding is never created directly, it is the sum of its transactions,
    /// so the one way to add a holding IS to add a transaction — and that
    /// entry point belongs on the tab where holdings are looked at, not only
    /// two screens away on the journal.
    static func current(tab: AppTab, destination: Route?) -> TopBarAdd? {
        switch destination {
        case nil where tab == .watchlist: .watchlist
        case nil where tab == .options: .option
        case nil where tab == .holdings: .transaction
        case .transactions: .transaction
        default: nil
        }
    }
}

/// Whether the bar shows an Edit toggle, kept as data for the same reason
/// `TopBarAdd` is — so a test can pin when it appears without mounting
/// SwiftUI.
enum TopBarEdit: Equatable, Sendable {
    case watchlist

    var accessibilityLabel: String {
        switch self {
        case .watchlist: "Edit watchlist"
        }
    }

    /// Nil everywhere but the watchlist root with tiles on it. An Edit button
    /// over an empty grid edits nothing — the empty-state text is already the
    /// whole screen. And edit mode is a root-screen state, not something a
    /// pushed page inherits: the stock page under this bar has no badges to
    /// show, so the toggle would flip nothing visible.
    static func current(tab: AppTab, destination: Route?, hasItems: Bool) -> TopBarEdit? {
        guard tab == .watchlist, destination == nil, hasItems else { return nil }
        return .watchlist
    }
}

extension Route {
    /// The word the bar puts next to the back chevron. Option contracts
    /// prefer the short "AAPL 180 C" form — the OCC ticker does not fit a
    /// 48pt row and the long CALL/PUT line already lives in the page header.
    func topBarTitle(optionCard: OptionCardItem? = nil) -> String {
        switch self {
        case let .instrument(symbol):
            symbol
        case .transactions:
            "Transactions"
        case .optionContract:
            optionCard.map(Self.optionTitle(for:)) ?? "Contract"
        case let .dividends(ticker):
            ticker.map { "\($0) dividends" } ?? "Dividends"
        case .analytics:
            "Analytics"
        case .dayReport:
            "Day report"
        case let .news(ticker):
            ticker.map { "\($0) news" } ?? "News"
        case .newsArticle:
            "Story"
        case let .marketDetail(key):
            key.displayTitle
        }
    }

    /// Short enough for the 48pt row. The long "AAPL $180 CALL" line stays
    /// on the contract page itself.
    static func optionTitle(for card: OptionCardItem) -> String {
        optionTitle(underlying: card.underlying, strikeLabel: card.strikeLabel, type: card.contractType)
    }

    static func optionTitle(underlying: String, strikeLabel: String, type: ContractType) -> String {
        "\(underlying) \(strikeLabel) \(type == .call ? "C" : "P")"
    }
}

/// The persistent top bar: brand (or back + title) on the left, optional
/// add, a stock-search magnifier, and the profile glyph on the right.
///
/// It sits ABOVE the `TabView` rather than inside any one tab, which is what
/// makes it persistent by construction: it is not in a scroll container, so
/// it cannot hide on scroll, and it is not in a navigation stack, so pushing
/// a stock's page does not take it away. The mirror of the bottom bar below.
///
/// The fill is `surface-1` from the top of the display through the 48pt row
/// — the web bar's `pt-[env(safe-area-inset-top)]` + `bg-surface-1`. A fill
/// that stopped at the safe-area edge left the status band as `surface-0`,
/// and on iOS 26 a scrolling card painted through that band.
///
/// Profile opens as a sheet rather than a push for the same reason as
/// before — the bar belongs to no stack, so it has none to push onto.
struct TopBar: View {
    let mode: TopBarMode
    var add: TopBarAdd?
    var edit: TopBarEdit?
    var isEditing: Bool = false
    var onBack: () -> Void = {}
    var onAdd: () -> Void = {}
    var onToggleEdit: () -> Void = {}
    var onSearch: () -> Void = {}
    let onProfile: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            leading
                .layoutPriority(1)

            Spacer(minLength: 8)

            if let edit {
                // A word, not a glyph: "Edit"/"Done" is the platform's own
                // spelling for a mode toggle, and the word IS the state — a
                // pencil icon would need a second signal to say which way the
                // next tap goes.
                Button(action: onToggleEdit) {
                    Text(isEditing ? "Done" : "Edit")
                        .font(.system(.subheadline, weight: .semibold))
                        .foregroundStyle(Color(Tokens.accent))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(edit.accessibilityLabel)
                .accessibilityValue(isEditing ? "Editing" : "Not editing")
            }

            if let add {
                Button(action: onAdd) {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color(Tokens.accent))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(add.accessibilityLabel)
            }

            Button(action: onSearch) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textSecondary))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Find a stock")

            Button(action: onProfile) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 22))
                    .foregroundStyle(Color(Tokens.textSecondary))
                    // 44pt is the tap-target floor, same as the web's size-11.
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Profile")
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(height: 48)
        // `ignoresSafeArea` on the fill only — the controls stay below the
        // island. TabView children also ignore the top safe area and would
        // paint over this cap if the bar lost the z-order fight, so the
        // caller pins `.zIndex(1)`.
        .background(Color(Tokens.surface1).ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(Tokens.borderSubtle))
                .frame(height: 1 / UIScreen.main.scale)
        }
    }

    @ViewBuilder
    private var leading: some View {
        switch mode {
        case .brand:
            HStack(spacing: 8) {
                BullMark().frame(width: 24)
                Text("StockHODL")
                    .font(.system(.subheadline, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("StockHODL")

        case let .pushed(title):
            Button(action: onBack) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color(Tokens.accent))
                    Text(title)
                        .font(.system(.subheadline, weight: .semibold))
                        .foregroundStyle(Color(Tokens.textPrimary))
                        .lineLimit(1)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Back")
            .accessibilityValue(title)
        }
    }
}

#Preview("brand") {
    VStack(spacing: 0) {
        TopBar(mode: .brand, onProfile: {})
        Color(Tokens.surface0)
    }
}

#Preview("pushed") {
    VStack(spacing: 0) {
        TopBar(mode: .pushed("CDR.WA"), add: .transaction, onProfile: {})
        Color(Tokens.surface0)
    }
}
