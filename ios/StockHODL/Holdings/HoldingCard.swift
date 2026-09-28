import SwiftUI

/// One position.
///
/// Every figure on this card arrives from the server as a preformatted string —
/// `valuePLN`, `unrealizedPct`, `dayPct.text`. That is not laziness: the money
/// pipeline is `numeric` → string → `decimal.js`, and re-deriving a display
/// value here would mean a second rounding implementation on a device that
/// cannot be trusted with `Double`. The client's job is to place the text and
/// colour it, and `Direction` carries the colour decision so a sign is never
/// turned into a colour by hand.
///
/// Reading order is still logo, identity, then a two-column figures row
/// (share price left, position value right). Rank is visual, not positional:
/// the PLN value is the largest number because the card answers "what is
/// this worth" first and "what is the share doing" second.
struct HoldingCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let holding: LiveHolding
    let statics: StaticHolding?

    var body: some View {
        QuietGroup {
            VStack(alignment: .leading, spacing: QuietDesign.Space.medium) {
                HStack(alignment: .top, spacing: QuietDesign.Space.medium) {
                    TickerLogo(symbol: statics?.symbol ?? "", size: 40)
                    identity
                }
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                        valueCluster
                        priceCluster
                    }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: QuietDesign.Space.section) {
                            valueCluster
                            Spacer(minLength: 0)
                            priceCluster
                        }
                        VStack(alignment: .leading, spacing: QuietDesign.Space.small) {
                            valueCluster
                            priceCluster
                        }
                    }
                }
            }
        }
    }

    // MARK: - Identity

    private var identity: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(statics?.symbol ?? holding.instrumentId)
                    .font(.system(.subheadline, weight: .semibold))
                    .foregroundStyle(Color(Tokens.textPrimary))

                // The server's own verdict that the sold quantity exceeds what
                // was ever bought. Shown, not silently corrected: the fix is a
                // missing transaction, and only the user knows which.
                if statics?.oversold == true { oversoldBadge }
            }

            if let statics {
                HStack(spacing: 4) {
                    // The name gives up its width first: a long company name
                    // truncates while the share count — which changes meaning
                    // if clipped — stays whole.
                    Text(statics.displayName)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("·")
                    Text(shares(statics.quantity))
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(QuietDesign.TypeRole.supporting)
                .foregroundStyle(Color(Tokens.textMuted))
            }
        }
    }

    private var oversoldBadge: some View {
        HStack(spacing: 3) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9))
            Text("Oversold")
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(Color(Tokens.loss))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(Tokens.loss).opacity(0.4), lineWidth: 1)
        )
        .fixedSize()
    }

    /// Same rule as the web card: singular at exactly one. Fractional
    /// quantities are strings from the server and never equal "1", so they
    /// take the plural — which is also what English does with 0,5.
    private func shares(_ quantity: String) -> String {
        "\(quantity) \(quantity == "1" ? "share" : "shares")"
    }

    // MARK: - Price (rank 2)

    private var priceCluster: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Share price")
                .font(QuietDesign.TypeRole.metadata)
                .foregroundStyle(Color(Tokens.textMuted))
            VStack(alignment: .leading, spacing: QuietDesign.Space.xSmall) {
                if let price = holding.price {
                    Text(price)
                        .font(QuietDesign.TypeRole.body)
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textPrimary))

                    // The day figure is BOUND to the price: shown with it,
                    // omitted with it. An unknown move is simply absent, never
                    // a confident 0,00%.
                    if let day = holding.dayPct {
                        Text("Today \(day.text)")
                            .font(QuietDesign.TypeRole.supporting)
                            .monospacedDigit()
                            .foregroundStyle(Color(day.direction.token))
                    }
                } else if let cached = holding.cachedPrice {
                    // A price the server could not refresh this round. Muted
                    // and labelled below, which is the honest version of
                    // showing it anyway.
                    Text(cached.text)
                        .font(.system(.body, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(Color(Tokens.textMuted))
                } else {
                    Text("—")
                        .font(.system(.body, weight: .medium))
                        .foregroundStyle(Color(Tokens.textMuted))
                }
            }

            if holding.price == nil, let cached = holding.cachedPrice {
                CachedAsOfLabel(asOfMs: cached.asOfMs)
            }

            if let extended = holding.extended {
                // Pre- and post-market moves are a separate fact from the
                // regular session's, and the server has already decided which
                // applies and whether it is still live. Flattening them into
                // the day change would misreport both.
                ExtendedMoveView(extended: extended, variant: .full)
            }
        }
    }

    // MARK: - Value (rank 1)

    private var valueCluster: some View {
        VStack(alignment: .leading, spacing: QuietDesign.Space.xSmall) {
            Text("Position value")
                .font(QuietDesign.TypeRole.metadata)
                .foregroundStyle(Color(Tokens.textMuted))
            // Tabular figures everywhere a number can change under the user's
            // eyes; without it the column jitters on every tick.
            QuietFinancialValue(text: holding.valuePLN ?? "—")

            QuietLabeledFigure(label: "Total P/L", value: holding.unrealizedPct, direction: holding.direction)
        }
    }
}
