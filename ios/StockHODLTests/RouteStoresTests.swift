import Foundation
import Testing

@testable import StockHODL

/// The regression this type exists for: `navigationDestination`'s closure is
/// re-invoked on every re-render of the view that owns the stack, and a store
/// built inside it was replaced by an empty one mid-screen.
@MainActor
struct RouteStoresTests {
    private func makeInstrumentStore(symbol: String) -> InstrumentStore {
        let api = APIClient(
            config: AppConfig(baseURL: URL(string: "https://example.test")!),
            transport: { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (Data(), response)
            }
        )
        return InstrumentStore(
            symbol: symbol,
            client: InstrumentClient(api: api),
            tokenProvider: { nil },
            defaults: UserDefaults(suiteName: "route-stores-\(UUID().uuidString)")!
        )
    }

    @Test("The same symbol gets the same store on every lookup")
    func sameSymbolIsMemoised() {
        let stores = RouteStores()
        var built = 0

        let first = stores.instrument("NET") { built += 1; return makeInstrumentStore(symbol: "NET") }
        let second = stores.instrument("NET") { built += 1; return makeInstrumentStore(symbol: "NET") }

        #expect(built == 1)
        #expect(first === second)
    }

    @Test("Two symbols get two stores")
    func distinctSymbolsAreDistinct() {
        let stores = RouteStores()

        let net = stores.instrument("NET") { makeInstrumentStore(symbol: "NET") }
        let aapl = stores.instrument("AAPL") { makeInstrumentStore(symbol: "AAPL") }

        #expect(net !== aapl)
        #expect(net.symbol == "NET")
        #expect(aapl.symbol == "AAPL")
    }

    @Test("The map is bounded, oldest first")
    func evictsBeyondTheLimit() {
        let stores = RouteStores(limit: 2)

        let net = stores.instrument("NET") { makeInstrumentStore(symbol: "NET") }
        _ = stores.instrument("AAPL") { makeInstrumentStore(symbol: "AAPL") }
        // Re-reading NET makes AAPL the oldest.
        #expect(stores.instrument("NET") { makeInstrumentStore(symbol: "NET") } === net)
        _ = stores.instrument("MSFT") { makeInstrumentStore(symbol: "MSFT") }

        #expect(stores.instrumentCount == 2)
        #expect(stores.instrument("NET") { makeInstrumentStore(symbol: "NET") } === net)

        var rebuiltAAPL = false
        _ = stores.instrument("AAPL") { rebuiltAAPL = true; return makeInstrumentStore(symbol: "AAPL") }
        #expect(rebuiltAAPL)
    }

    @Test("Sign-out drops everything derived from the account")
    func purgeClears() {
        let stores = RouteStores()
        let before = stores.instrument("NET") { makeInstrumentStore(symbol: "NET") }
        let market = stores.marketDetail(.usdpln) { makeMarketDetailStore(key: .usdpln) }

        stores.purge()

        #expect(stores.instrumentCount == 0)
        #expect(stores.marketDetailCount == 0)
        let after = stores.instrument("NET") { makeInstrumentStore(symbol: "NET") }
        #expect(before !== after)
        #expect(stores.marketDetail(.usdpln) { makeMarketDetailStore(key: .usdpln) } !== market)
    }

    // MARK: - Market detail (2026-09-20)

    private func makeMarketDetailStore(key: MarketTileKey) -> MarketDetailStore {
        let api = APIClient(
            config: AppConfig(baseURL: URL(string: "https://example.test")!),
            transport: { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (Data(), response)
            }
        )
        return MarketDetailStore(
            key: key,
            client: MarketStripClient(api: api),
            tokenProvider: { nil },
            defaults: UserDefaults(suiteName: "route-stores-\(UUID().uuidString)")!
        )
    }

    @Test("The same tile key gets the same market detail store on every lookup")
    func marketDetailIsMemoised() {
        let stores = RouteStores()
        var built = 0

        let first = stores.marketDetail(.spy) { built += 1; return makeMarketDetailStore(key: .spy) }
        let second = stores.marketDetail(.spy) { built += 1; return makeMarketDetailStore(key: .spy) }

        #expect(built == 1)
        #expect(first === second)
        #expect(first.key == .spy)
    }

    @Test("Two tile keys get two market detail stores, independent of the instrument map")
    func distinctKeysAreDistinct() {
        let stores = RouteStores(limit: 1)

        let spy = stores.marketDetail(.spy) { makeMarketDetailStore(key: .spy) }
        let fx = stores.marketDetail(.usdpln) { makeMarketDetailStore(key: .usdpln) }
        // The instrument map's bound does not evict market stores.
        _ = stores.instrument("NET") { makeInstrumentStore(symbol: "NET") }
        _ = stores.instrument("AAPL") { makeInstrumentStore(symbol: "AAPL") }

        #expect(spy !== fx)
        #expect(stores.marketDetailCount == 2)
        #expect(stores.marketDetail(.spy) { makeMarketDetailStore(key: .spy) } === spy)
    }
}
