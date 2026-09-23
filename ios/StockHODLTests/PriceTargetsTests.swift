import Foundation
import Testing

@testable import StockHODL

/// The target row's rendering rule — wording, glyph and the hit-time format —
/// exercised on the UI-free model, the `WatchActionModel` precedent.
@Suite("Price target row model")
struct PriceTargetsTests {
    private func target(
        direction: TargetDirection = .up,
        hitAtMs: Int? = nil,
        targetPrice: String = "190.5"
    ) -> PriceTarget {
        PriceTarget(
            createdAtMs: 1_757_000_000_000,
            direction: direction,
            hitAtMs: hitAtMs,
            id: "t1",
            instrumentId: "i1",
            targetPrice: targetPrice
        )
    }

    @Test("an up target gets the up-right glyph, a down target the down-right one")
    func glyphPerDirection() {
        #expect(PriceTargetRowModel.from(target(direction: .up), currency: "USD").glyph
            == "arrow.up.right")
        #expect(PriceTargetRowModel.from(target(direction: .down), currency: "USD").glyph
            == "arrow.down.right")
    }

    @Test("a pending target says Waiting, in words — never state by color alone")
    func waitingWording() {
        let model = PriceTargetRowModel.from(target(), currency: "USD")
        #expect(model.stateText == "Waiting")
        #expect(!model.isHit)
    }

    @Test("a hit target says Hit with its instant, and stays distinguishable from a waiting one")
    func hitWording() {
        let ms = 1_757_082_300_000
        let model = PriceTargetRowModel.from(target(hitAtMs: ms), currency: "USD")
        #expect(model.stateText == "Hit \(PriceTargetRowModel.hitTime(ms))")
        #expect(model.isHit)
    }

    /// The next instant that is a whole hour in the FORMATTER's own zone —
    /// the `ChartLabelsTests` construction, because a literal instant that is
    /// on the hour in Warsaw is ":30" on a machine at +05:30.
    private var wholeHourHere: Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let from = Date(timeIntervalSince1970: 1_757_082_300)
        let onTheDot = calendar.nextDate(
            after: from,
            matching: DateComponents(minute: 0, second: 0),
            matchingPolicy: .nextTime
        ) ?? from
        return Int(onTheDot.timeIntervalSince1970 * 1000)
    }

    @Test("the hit time prints both minute digits — a whole hour never ends in a bare :0")
    func hitTimeKeepsBothMinuteDigits() {
        let formatted = PriceTargetRowModel.hitTime(wholeHourHere)
        #expect(formatted.hasSuffix(":00"))
        #expect(formatted.split(separator: ":").last?.count == 2)
    }

    @Test("the price formats through Money.swift, in the instrument's currency")
    func priceFormatsThroughMoney() {
        let model = PriceTargetRowModel.from(target(targetPrice: "190.5"), currency: "USD")
        #expect(model.priceText == fmtMoney(dec("190.5")!, currency: "USD"))
    }

    @Test("a price string that will not parse renders verbatim, never as a fabricated zero")
    func unparseablePriceRendersVerbatim() {
        let model = PriceTargetRowModel.from(target(targetPrice: "not-a-price"), currency: "USD")
        #expect(model.priceText == "not-a-price")
    }

    @Test("the spoken label carries the direction in words — the glyph never carries it alone")
    func accessibilityCarriesDirection() {
        let up = PriceTargetRowModel.from(target(direction: .up), currency: "USD")
        let down = PriceTargetRowModel.from(target(direction: .down), currency: "USD")
        #expect(up.accessibilityLabel.contains("above"))
        #expect(down.accessibilityLabel.contains("below"))
        #expect(up.accessibilityLabel.contains("Waiting"))
    }
}
