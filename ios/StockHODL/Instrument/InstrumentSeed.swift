import Foundation

/// The little the app already knows about a stock before it asks the server.
///
/// A stock's page is reached by tapping a row on Holdings, the Dashboard or
/// the watchlist — every one of which was drawn from a payload the app already
/// has. Offline, that tap produced a spinner and then a full-screen error,
/// while the name, the price and the day's move for that exact ticker sat in
/// the snapshot the list behind it had just been painted from. The first time
/// you visit a stock without a connection is the only case the on-disk
/// instrument cache cannot cover, and it is the common one.
///
/// **What this deliberately is NOT is a reconstructed `InstrumentResponse`.**
/// That struct carries `position`, `dayStats`, `groups` and `transactions`,
/// none of which the holdings payload contains. Filling them with empties
/// would make the screen state that a stock the user owns is unowned and has
/// no history, which is worse than admitting we do not know; filling them by
/// re-deriving would be a second money implementation on the one platform
/// where `Double` is a footgun (non-negotiable #1). So this carries the header
/// and stops, and the screen says the rest is waiting on a connection.
///
/// Every field is a server-formatted string carried through untouched. Nothing
/// here computes anything.
struct InstrumentSeed: Sendable, Equatable {
    let symbol: String
    let displayName: String
    let currency: Currency
    /// The live price, when the payload had one.
    let price: String?
    let dayPct: LiveFigure?
    /// The last saved price, for the same muted fallback the real header uses.
    let cachedPrice: CachedPrice?

    static func == (lhs: InstrumentSeed, rhs: InstrumentSeed) -> Bool {
        lhs.symbol == rhs.symbol
            && lhs.displayName == rhs.displayName
            && lhs.price == rhs.price
    }
}

extension LiveStore {
    /// A seed for one symbol, out of whatever this store is already holding.
    ///
    /// Reads the STATIC half for identity and the live half for figures, which
    /// is the same join `staticHolding(for:)` does in the other direction. Nil
    /// when the symbol is not one of the user's — a watchlist-only ticker
    /// reached from a deep link, say — because a seed made of nothing is just
    /// a spinner with extra steps.
    func seed(for symbol: String) -> InstrumentSeed? {
        guard let statics = bootstrap?.staticHoldings.first(where: { $0.symbol == symbol }) else {
            return nil
        }
        let figures = live?.holdings.first { $0.instrumentId == statics.instrumentId }
        return InstrumentSeed(
            symbol: statics.symbol,
            displayName: statics.displayName,
            currency: statics.currency,
            price: figures?.price,
            dayPct: figures?.dayPct,
            cachedPrice: figures?.cachedPrice
        )
    }
}
