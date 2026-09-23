import Foundation
import Testing

@testable import StockHODL

/// The client half of the anti-drift pair.
///
/// `src/lib/api/contracts/live-payload-contract.test.ts` proves the SERVER's
/// composer still matches the schema. This proves the SWIFT generated from that
/// same schema still decodes the payload the schema describes. Neither test is
/// sufficient alone: the first would pass while the phone silently decodes
/// nothing, and the second would pass against a fixture that the server stopped
/// producing years ago.
///
/// The fixture below is deliberately hand-written rather than captured, so a
/// field going missing from the server shows up as a compile-time or decode-
/// time failure here rather than as a screen full of "—".
@Suite("Contracts")
struct ContractsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test("a live payload decodes with every money field still a String")
    func livePayload() throws {
        let payload = try decode(LivePayload.self, """
        {
          "market": {
            "status": "open",
            "nextTransitionAtMs": 1754800000000,
            "nextTransitionKind": "close",
            "pollingResumesAtMs": null,
            "serverNowMs": 1754790000000
          },
          "summary": {
            "totalValue": "23708.11",
            "dayChange": { "text": "+20,46 zł", "direction": "gain" },
            "totalChange": { "text": "-3,46%", "direction": "loss" },
            "excludedSymbols": ["MSFT"],
            "partialDayChange": true
          },
          "holdings": [
            {
              "instrumentId": "11111111-1111-4111-8111-111111111111",
              "price": "110.25",
              "cachedPrice": { "text": "109,00", "asOfMs": 1754700000000 },
              "dayPct": { "text": "+4,76%", "direction": "gain" },
              "extended": {
                "text": "+1,25%",
                "direction": "gain",
                "kind": "late",
                "live": false,
                "endedAtMs": 1754800000000
              },
              "unrealizedPLN": "410.00",
              "unrealizedPct": "10.25",
              "direction": "gain",
              "valuePLN": "4410,00 zł",
              "valuePLNRaw": "4410.00",
              "unrealizedPLNRaw": "410.00"
            }
          ],
          "scopes": [
            {
              "id": "22222222-2222-4222-8222-222222222222",
              "summary": {
                "totalValue": "4410.00",
                "dayChange": { "text": "—", "direction": "neutral" },
                "totalChange": { "text": "—", "direction": "neutral" },
                "excludedSymbols": [],
                "partialDayChange": false
              },
              "holdings": []
            }
          ],
          "hasPollableSymbols": true
        }
        """)

        #expect(payload.market.status == .marketStatusOpen)
        #expect(payload.market.nextTransitionKind == .close)
        #expect(payload.holdings.count == 1)

        // The whole discipline in one assertion: the amount arrived as text and
        // only becomes a number by going through `dec`.
        let price = try #require(payload.holdings[0].price)
        #expect(price == "110.25")
        #expect(dec(price) == dec("110.25"))

        #expect(payload.holdings[0].extended?.kind == .late)
        #expect(payload.summary.dayChange?.direction == .gain)
    }

    @Test("the degraded payload decodes — no quote, no FX rate")
    func degradedPayload() throws {
        // Every figure nulls out when a symbol has no quote. "—" over a fake
        // zero is the display contract; a decoder that required the strings
        // would force the server to lie.
        let payload = try decode(LivePayload.self, """
        {
          "market": {
            "status": "closed",
            "nextTransitionAtMs": null,
            "nextTransitionKind": null,
            "pollingResumesAtMs": null,
            "serverNowMs": 1754790000000
          },
          "summary": {
            "totalValue": null,
            "dayChange": { "text": "—", "direction": "neutral" },
            "totalChange": { "text": "—", "direction": "neutral" },
            "excludedSymbols": ["AAPL"],
            "partialDayChange": false
          },
          "holdings": [
            {
              "instrumentId": "11111111-1111-4111-8111-111111111111",
              "price": null,
              "cachedPrice": null,
              "dayPct": null,
              "extended": null,
              "unrealizedPLN": null,
              "unrealizedPct": "—",
              "direction": "neutral",
              "valuePLN": null,
              "valuePLNRaw": null,
              "unrealizedPLNRaw": null
            }
          ],
          "scopes": [],
          "hasPollableSymbols": false
        }
        """)

        #expect(payload.holdings[0].price == nil)
        #expect(payload.summary.totalValue == nil)
        #expect(payload.market.status == .closed)

        // Not every absent figure is a null. `unrealizedPct` is a DISPLAY
        // string produced by `fmtPct`, which renders the unknown case as "—"
        // rather than returning nothing — so the contract types it
        // non-optional and the decoder is right to insist. Worth pinning: the
        // obvious-looking fix here is to make the Swift optional, which would
        // be papering over a payload the server never sends.
        #expect(payload.holdings[0].unrealizedPct == "—")
    }

    @Test("the FX refusal arms decode as distinct answers")
    func fxRateResponse() throws {
        let ok = try decode(FxRateResponse.self, """
        { "ok": true, "rate": "4.05", "rateDate": "2026-01-02" }
        """)
        #expect(ok.ok)
        #expect(ok.rate == "4.05")
        #expect(ok.reason == nil)

        let refused = try decode(FxRateResponse.self, """
        { "ok": false, "reason": "not_published" }
        """)
        #expect(!refused.ok)
        #expect(refused.reason == .notPublished)
        #expect(refused.rate == nil)
    }

    @Test("a chart point keeps its value as text and its instant as an integer")
    func chartPoint() throws {
        let point = try decode(ChartPoint.self, """
        { "t": 1754800000000, "v": "110.25", "p": "pre", "o": "109", "h": "111", "l": "108" }
        """)

        #expect(point.t == 1_754_800_000_000)
        #expect(point.v == "110.25")
        #expect(point.p == .pre)
        // Only the geometry layer is allowed to make this a Double, and this is
        // not it.
        #expect(dec(point.v) == dec("110.25"))
    }

    @Test("a transaction row carries every amount as a decimal string")
    func transactionRow() throws {
        let row = try decode(TransactionRow.self, """
        {
          "id": "11111111-1111-4111-8111-111111111111",
          "portfolioId": "22222222-2222-4222-8222-222222222222",
          "portfolioName": "Main",
          "instrumentId": "33333333-3333-4333-8333-333333333333",
          "symbol": "AAPL",
          "displayName": "Apple Inc.",
          "exchange": "NASDAQ",
          "currency": "USD",
          "side": "buy",
          "quantity": "10.00000000",
          "price": "100.00000000",
          "fees": "0.00000000",
          "tradeDate": "2026-01-05",
          "fxRateToBase": "4.0000000000",
          "note": null
        }
        """)

        #expect(row.side == .buy)
        #expect(row.currency == .usd)
        #expect(row.note == nil)

        // Cost basis computed the only sanctioned way: strings in, Decimal
        // arithmetic, never a Double in between.
        let quantity = try #require(dec(row.quantity))
        let price = try #require(dec(row.price))
        let fx = try #require(dec(row.fxRateToBase))
        #expect(toNumeric(quantity * price * fx, scale: 2) == "4000.00")
    }

    @Test("the market strip payload decodes with its key and its currency tile")
    func marketStripPayload() throws {
        let payload = try decode(MarketStripPayload.self, """
        {
          "tiles": [
            {
              "key": "SPY",
              "indexName": "S&P 500",
              "proxySymbol": "SPY",
              "last": "645,32 USD",
              "dayPct": { "text": "+0,84%", "direction": "gain" },
              "spark": [{ "t": 1754800000000, "v": "640.10" }]
            }
          ],
          "fx": {
            "key": "USDPLN",
            "pairLabel": "USD/PLN",
            "caption": "PLN per 1 USD",
            "last": "3,7955",
            "dayPct": { "text": "+0,12%", "direction": "gain" },
            "spark": [{ "t": 1754800000000, "v": "3.7900" }]
          },
          "market": {
            "status": "open",
            "nextTransitionAtMs": 1754800000000,
            "nextTransitionKind": "close",
            "pollingResumesAtMs": null,
            "serverNowMs": 1754790000000
          }
        }
        """)

        #expect(payload.tiles[0].key == .spy)
        #expect(payload.fx.key == .usdpln)
        #expect(payload.fx.last == "3,7955")
        // A rate is money on the wire: text in, Decimal only through `dec`.
        #expect(dec(payload.fx.spark[0].v) == dec("3.7900"))
        #expect(payload.fx.dayPct?.direction == .gain)
    }

    /// The forward-compatibility property the wire relies on: a key this
    /// build does not know is ignored, so an installed build keeps decoding a
    /// payload the server has since grown.
    @Test("an index tile with an unknown extra field still decodes")
    func unknownFieldIsIgnored() throws {
        let tile = try decode(IndexTile.self, """
        {
          "key": "QQQ",
          "indexName": "Nasdaq",
          "proxySymbol": "QQQ",
          "last": null,
          "dayPct": null,
          "spark": [],
          "somethingNewerServersSend": { "nested": true }
        }
        """)

        #expect(tile.key == .qqq)
        #expect(tile.last == nil)
    }

    @Test("an option card decodes its total cost, and tolerates its absence")
    func optionCardTotalCost() throws {
        let withCost = try decode(OptionCardItem.self, """
        {
          "breakEven": "223,50 USD",
          "contractType": "call",
          "daysToExpiry": 21,
          "delta": "0,64",
          "entryIsAverage": false,
          "entryPrice": "3,50 USD",
          "expirationDate": "2026-09-04",
          "expired": false,
          "expiryLabel": "4 wrz 2026",
          "fees": "1,02 USD",
          "gamma": "0,01",
          "hasQuote": true,
          "impliedVolatility": "29,00%",
          "key": "O:AAPL260904C00220000",
          "lastTradeBeyondLookback": false,
          "lastTradeLabel": "13 sie",
          "lotCount": 1,
          "lots": [
            {
              "entryPrice": "3,50 USD",
              "entryPriceRaw": "3.50000000",
              "fees": "1,02 USD",
              "feesRaw": "1.02000000",
              "id": "11111111-1111-4111-8111-111111111111",
              "quantity": "2",
              "quantityRaw": "2.00000000",
              "tradeDate": "2026-08-10",
              "tradeDateLabel": "10 sie"
            }
          ],
          "noTrade": false,
          "openInterest": "1500",
          "pl": { "direction": "gain", "text": "+42,86%" },
          "plDirection": "gain",
          "plPct": "+42,86%",
          "plRaw": "300.00000000",
          "price": "5,00 USD",
          "priceIsEstimate": false,
          "quantity": "2",
          "strike": "220,00 USD",
          "strikeLabel": "220",
          "theta": "-0,05",
          "ticker": "O:AAPL260904C00220000",
          "totalCost": "702,04 USD",
          "underlying": "AAPL",
          "valueRaw": "1000.00000000",
          "vega": "0,22"
        }
        """)
        #expect(withCost.totalCost == "702,04 USD")

        let withoutCost = try decode(OptionCardItem.self, """
        {
          "breakEven": "223,50 USD",
          "contractType": "call",
          "daysToExpiry": 21,
          "delta": "0,64",
          "entryIsAverage": false,
          "entryPrice": "3,50 USD",
          "expirationDate": "2026-09-04",
          "expired": false,
          "expiryLabel": "4 wrz 2026",
          "fees": "1,02 USD",
          "gamma": "0,01",
          "hasQuote": true,
          "impliedVolatility": "29,00%",
          "key": "O:AAPL260904C00220000",
          "lastTradeBeyondLookback": false,
          "lastTradeLabel": "13 sie",
          "lotCount": 1,
          "lots": [
            {
              "entryPrice": "3,50 USD",
              "entryPriceRaw": "3.50000000",
              "fees": "1,02 USD",
              "feesRaw": "1.02000000",
              "id": "11111111-1111-4111-8111-111111111111",
              "quantity": "2",
              "quantityRaw": "2.00000000",
              "tradeDate": "2026-08-10",
              "tradeDateLabel": "10 sie"
            }
          ],
          "noTrade": false,
          "openInterest": "1500",
          "pl": { "direction": "gain", "text": "+42,86%" },
          "plDirection": "gain",
          "plPct": "+42,86%",
          "plRaw": "300.00000000",
          "price": "5,00 USD",
          "priceIsEstimate": false,
          "quantity": "2",
          "strike": "220,00 USD",
          "strikeLabel": "220",
          "theta": "-0,05",
          "ticker": "O:AAPL260904C00220000",
          "underlying": "AAPL",
          "valueRaw": "1000.00000000",
          "vega": "0,22"
        }
        """)
        #expect(withoutCost.totalCost == nil)
    }
}
