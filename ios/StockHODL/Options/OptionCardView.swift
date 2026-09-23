import SwiftUI

/// One tracked contract's card — first ported from the retired web app's option
/// card; this is now the only implementation.
///
/// Every figure arrives pre-formatted from `composeOptionsPayload`: this view
/// does zero arithmetic and zero number parsing. Direction is never conveyed
/// by colour alone — the signs live in the formatted strings and the colour is
/// the shared `Direction.token` map. An absent figure is an em-dash BESIDE ITS
/// LABEL: a thin contract keeps its full definition list, dashes and all, and
/// a missing quote adds a muted note rather than dropping rows.
///
/// Manage lives behind the `⋯` menu (the web's pattern): opening the menu is
/// the friction, the item is the one tap. A card can stand for SEVERAL
/// `option_positions` rows, so the menu addresses LOTS — with one lot it is
/// two entries, with more it lists each purchase by date, size and price, so
/// an edit or a removal always lands on the purchase it names. Nothing owned
/// becomes unreachable, and nothing is mutable by proxy.
struct OptionCardView: View {
    let item: OptionCardItem
    /// `card` is the list tile and owns the headline that opens the contract's
    /// page. `detail` is the same card ON that page — the header already
    /// carries the identity, so the headline (and the link to where we already
    /// are) is dropped. Everything else is shared by construction: the two
    /// surfaces cannot drift.
    var variant: Variant = .card
    let onEdit: (OptionLotItem) -> Void
    let onRemove: (OptionLotItem) -> Void

    enum Variant { case card, detail }

    private var headline: String { OptionCardView.headline(for: item) }

    /// "AAPL $220 CALL" — the card's title, and the words a chart mark uses
    /// for the same contract, so the two can never name it differently.
    /// `nonisolated` because a View is main-actor by default and this is pure
    /// string work: `TradeMark.fromLots` calls it off the main actor.
    nonisolated static func headline(for item: OptionCardItem) -> String {
        let typeLabel = item.contractType == .call ? "CALL" : "PUT"
        return "\(item.underlying) $\(item.strikeLabel) \(typeLabel)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            priceRow
            figures
            if !item.hasQuote {
                Text("No quote yet — live figures show as dashes.")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .padding(.top, 8)
            }
            greeks
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 12).fill(Color(Tokens.surface1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                if variant == .card {
                    Text(headline)
                        .font(.system(.body, weight: .semibold))
                        .foregroundStyle(Color(Tokens.textPrimary))
                }

                expiryLine

                // The entry price is a quantity-weighted average once the card
                // stands for more than one purchase, and says so — an average
                // printed as if it were a paid price would be a quiet lie.
                Text(entryLine)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            Spacer(minLength: 0)
            manageMenu
        }
    }

    @ViewBuilder
    private var expiryLine: some View {
        HStack(spacing: 6) {
            if item.expired {
                Text("Expired \(item.expiryLabel)")
                Text("Expired")
                    .font(.system(size: 11, weight: .medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .overlay(Capsule().stroke(Color(Tokens.borderSubtle), lineWidth: 1))
                    .foregroundStyle(Color(Tokens.textSecondary))
            } else {
                Text("Expires \(item.expiryLabel) · \(daysLeftLabel)")
            }
        }
        .font(.caption)
        .foregroundStyle(Color(Tokens.textMuted))
    }

    /// Durations here are counts, not money — plain words from an integer.
    private var daysLeftLabel: String {
        switch item.daysToExpiry {
        case 0: "expires today"
        case 1: "1 day left"
        default: "\(item.daysToExpiry) days left"
        }
    }

    private var entryLine: String {
        var text = "\(item.quantity) contracts @ \(item.entryPrice)"
        if item.entryIsAverage { text += " avg · \(item.lotCount) lots" }
        if let fees = item.fees { text += " · \(fees) costs" }
        return text
    }

    private var manageMenu: some View {
        Menu {
            if item.lotCount == 1, let lot = item.lots.first {
                Button { onEdit(lot) } label: { Label("Edit lot", systemImage: "pencil") }
                Button(role: .destructive) { onRemove(lot) } label: {
                    Label("Remove contract", systemImage: "trash")
                }
            } else {
                // Each purchase by date, size and price, so an action can
                // never land on a different lot than its label names.
                ForEach(item.lots, id: \.id) { lot in
                    Section(lotLabel(lot)) {
                        Button { onEdit(lot) } label: { Label("Edit", systemImage: "pencil") }
                        Button(role: .destructive) { onRemove(lot) } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 17))
                .foregroundStyle(Color(Tokens.textSecondary))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(
            item.entryIsAverage
                ? "Manage \(headline), \(item.lotCount) lots"
                : "Manage \(headline)"
        )
    }

    /// A lot's identity in the menu: `12 sie · 2 @ 5,20 USD`.
    private func lotLabel(_ lot: OptionLotItem) -> String {
        "\(lot.tradeDateLabel) · \(lot.quantity) @ \(lot.entryPrice)"
    }

    // MARK: - Price

    private var priceRow: some View {
        // Day figure and the no-trade note are mutually exclusive by
        // construction — the resolver nulls the pair it disproves.
        FlowRow(spacing: 8) {
            Text(item.price ?? "—")
                .font(.system(.title3, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Color(Tokens.textPrimary))

            if item.priceIsEstimate {
                // A model mark is an ESTIMATE and says so beside the figure it
                // qualifies. The label is the mitigation for pricing off a
                // model, not decoration — it is not optional on the phone.
                Text("estimate")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            if let day = item.day {
                Text(day.text)
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(Color(day.direction.token))
            }

            if let basis = item.dayBasisLabel {
                // An estimate's move is measured against a recorded EVENING'S
                // estimate, and names it — a made-up price and a traded price
                // are never subtracted from each other.
                Text(basis)
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            if item.noTrade {
                // Bars PROVED the contract did not trade this session — said
                // in words, never as a fake flat 0,00%.
                Text("No trades this session")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            if item.lastTradeBeyondLookback {
                Text("last trade over a month ago")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
            } else if let last = item.lastTradeLabel {
                Text("last trade \(last)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textMuted))
            }
        }
        .padding(.top, 12)
    }

    // MARK: - Figures

    private var figures: some View {
        VStack(alignment: .leading, spacing: 4) {
            // The figure is server-formatted; the dash is only for a payload
            // from a build that predates the field. Neutral text colour —
            // cost has no direction.
            HStack(alignment: .firstTextBaseline) {
                Text("Total cost paid")
                    .foregroundStyle(Color(Tokens.textMuted))
                Spacer(minLength: 8)
                Text(item.totalCost ?? "—")
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
            }

            HStack(alignment: .firstTextBaseline) {
                // The caption qualifies the AMOUNT only. The percent beside it
                // is per-share against entry and stays gross — a lot-level
                // cost mixed into a per-share percent would be neither figure.
                Text("Your P/L")
                    .foregroundStyle(Color(Tokens.textMuted))
                Spacer(minLength: 8)
                Text(item.pl?.text ?? "—")
                    .monospacedDigit()
                    .foregroundStyle(Color(item.pl.map { $0.direction.token } ?? Tokens.textPrimary))
            }

            if let fees = item.fees, item.pl != nil {
                Text("Amount is after \(fees) in costs; the percent is per share, before costs.")
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .multilineTextAlignment(.trailing)
            }

            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Break-even")
                        .foregroundStyle(Color(Tokens.textMuted))
                    Text(
                        item.entryIsAverage
                            ? "(at expiry, from your average entry)"
                            : "(at expiry, from your entry)"
                    )
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textMuted))
                }
                Spacer(minLength: 8)
                Text(item.breakEven)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
            }

            HStack(alignment: .firstTextBaseline) {
                Text("Strike").foregroundStyle(Color(Tokens.textMuted))
                Spacer(minLength: 8)
                Text(item.strike)
                    .monospacedDigit()
                    .foregroundStyle(Color(Tokens.textPrimary))
            }
        }
        .font(.subheadline)
        .padding(.top, 8)
    }

    /// Every absent value keeps its label and renders an em-dash — never 0,
    /// never dropped. Three columns on a phone, matching the web's narrow
    /// shell before its `sm:` six.
    private var greeks: some View {
        // The rule is a SIBLING, not an overlay on the grid: as an overlay it
        // draws at the top of the padded frame and crowds the Strike row above.
        VStack(spacing: 12) {
            Rectangle()
                .fill(Color(Tokens.borderSubtle))
                .frame(height: 1)

            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 3),
                alignment: .leading,
                spacing: 8
            ) {
                greek("Delta", item.delta)
                greek("Gamma", item.gamma)
                greek("Theta", item.theta)
                greek("Vega", item.vega)
                greek("IV", item.impliedVolatility)
                greek("Open int.", item.openInterest)
            }
        }
        .padding(.top, 12)
    }

    private func greek(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .foregroundStyle(Color(Tokens.textMuted))
            Text(value)
                .monospacedDigit()
                .foregroundStyle(Color(Tokens.textPrimary))
        }
        .font(.caption)
    }
}
