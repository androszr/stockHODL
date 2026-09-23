import Foundation
import Testing

@testable import StockHODL

/// The tile marker's rendering rule — glyphs, the accent decision and the
/// spoken sentence — exercised on the UI-free model, the
/// `PriceTargetRowModel` precedent.
@Suite("Target line model")
struct TargetLineModelTests {
    private func status(
        text: String = "3,21%",
        sentence: String = "3,21% below your 190,00 USD line",
        side: TargetSide? = .below,
        near: Bool = true,
        hitOnly: Bool = false
    ) -> TargetStatus {
        TargetStatus(hitOnly: hitOnly, near: near, sentence: sentence, side: side, text: text)
    }

    @Test("no status means no marker at all — the Dashboard path")
    func nilStatusYieldsNoModel() {
        #expect(TargetLineModel.from(nil) == nil)
    }

    @Test("a waiting line draws the target glyph with the server's compact text")
    func waitingLineGlyphAndText() {
        let model = TargetLineModel.from(status())
        #expect(model?.glyph == "target")
        #expect(model?.text == "3,21%")
    }

    @Test("price below the line points UP — the price must rise to reach it")
    func belowPointsUp() {
        #expect(TargetLineModel.from(status(side: .below))?.arrow == "arrow.up.right")
    }

    @Test("price above the line points DOWN")
    func abovePointsDown() {
        #expect(TargetLineModel.from(status(side: .above))?.arrow == "arrow.down.right")
    }

    @Test("no side — at the line, or unpriced — draws no arrow rather than a guessed one")
    func nilSideDrawsNoArrow() {
        let model = TargetLineModel.from(status(text: "—", side: nil, near: false))
        #expect(model?.arrow == nil)
        #expect(model?.text == "—")
    }

    @Test("the hit-only variant swaps to a checkmark, no arrow, muted")
    func hitVariant() {
        let model = TargetLineModel.from(
            status(
                text: "Hit",
                sentence: "Your 190,00 USD line has been hit",
                side: nil,
                near: false,
                hitOnly: true
            )
        )
        #expect(model?.glyph == "checkmark")
        #expect(model?.arrow == nil)
        #expect(model?.text == "Hit")
        #expect(model?.isNear == false)
    }

    @Test("near picks the accent token, far the muted one — a Bool, decided here once")
    func nearDecidesTheToken() {
        #expect(TargetLineModel.from(status(near: true))?.isNear == true)
        #expect(TargetLineModel.from(status(near: false))?.isNear == false)
    }

    @Test("the spoken label is the server's full sentence — words, never a glyph or color alone")
    func accessibilityLabelIsTheSentence() {
        let model = TargetLineModel.from(status())
        #expect(model?.accessibilityLabel == "3,21% below your 190,00 USD line")
    }
}
