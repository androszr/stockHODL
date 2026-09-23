import Foundation
import Testing
import UIKit

@testable import StockHODL

private final class FakeImportServer: @unchecked Sendable {
    private let lock = NSLock()

    private(set) var calls = 0
    /// The base64 the client actually uploaded, so a test can prove the
    /// picture was downscaled rather than sent whole.
    private(set) var lastBase64: String?

    var failure: (status: Int, body: String)?
    var response = ImportFixture.prefill()

    func transport() -> APIClient.Transport {
        { [self] request in
            struct Body: Decodable { let imageBase64: String }
            let uploaded = request.httpBody.flatMap { try? JSONDecoder().decode(Body.self, from: $0) }

            let failed = lock.withLock { () -> (status: Int, body: String)? in
                calls += 1
                lastBase64 = uploaded?.imageBase64
                return failure
            }

            let status = failed?.status ?? 200
            let body: Data
            if let failed {
                body = Data(failed.body.utf8)
            } else {
                body = try JSONEncoder().encode(lock.withLock { response })
            }
            let http = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!
            return (body, http)
        }
    }
}

private enum ImportFixture {
    static func prefill(
        quantity: String? = "10",
        side: TransactionSide? = .buy,
        notes: [PrefillNote] = []
    ) -> TransactionImportResponse {
        TransactionImportResponse(
            companyName: "Apple Inc.",
            formPrefill: FormPrefill(
                fees: "1.20",
                price: "220.50",
                quantity: quantity,
                side: side,
                symbolQuery: "AAPL",
                tradeDate: "2026-08-14"
            ),
            isin: nil,
            notes: notes,
            priceCurrency: "USD",
            priceCurrencyTrusted: true,
            readFields: ["quantity", "price"],
            screenKind: .transaction
        )
    }

    /// A picture bigger than the long-edge cap, so `prepare` has to shrink it.
    static func oversizedImage() -> UIImage {
        let size = CGSize(width: 4000, height: 2000)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.darkGray.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }

    static func smallImage() -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40), format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
        }
    }
}

@MainActor
private func makeStore(
    _ server: FakeImportServer,
    token: String? = "signed.token"
) -> ImportStore {
    ImportStore(
        client: ImportClient(
            api: APIClient(
                config: AppConfig(baseURL: URL(string: "https://example.test")!),
                transport: server.transport()
            )
        ),
        tokenProvider: { token }
    )
}

@Suite("Screenshot import store")
@MainActor
struct ImportStoreTests {
    @Test("a read returns the server's prefill")
    func reads() async {
        let server = FakeImportServer()
        let store = makeStore(server)

        let result = await store.readTransaction(ImportFixture.smallImage())

        #expect(result?.formPrefill.quantity == "10")
        #expect(store.errorMessage == nil)
        #expect(!store.isReading)
    }

    @Test("the server's own sentence is what the user reads")
    func keepsServerSentence() async {
        let server = FakeImportServer()
        server.failure = (422, #"{"error":"Nothing readable was found in that screenshot.","reason":"unparseable"}"#)
        let store = makeStore(server)

        #expect(await store.readTransaction(ImportFixture.smallImage()) == nil)

        // "Could not read that screenshot" would send someone hunting for a
        // better picture when the answer is already on the wire.
        #expect(store.errorMessage?.contains("Nothing readable") == true)
        #expect(!store.isRateLimited)
    }

    @Test("a rate limit is flagged apart from every other failure")
    func flagsRateLimit() async {
        let server = FakeImportServer()
        server.failure = (429, #"{"error":"Too many reads in a short time.","reason":"rate_limited"}"#)
        let store = makeStore(server)

        #expect(await store.readTransaction(ImportFixture.smallImage()) == nil)

        // Waiting and trying another picture are different actions, and each
        // costs the user something different to get wrong — one is time, the
        // other is money.
        #expect(store.isRateLimited)
    }

    @Test("a failure with no sentence still says something")
    func genericFailure() async {
        let server = FakeImportServer()
        server.failure = (500, "not json at all")
        let store = makeStore(server)

        #expect(await store.readTransaction(ImportFixture.smallImage()) == nil)
        #expect(store.errorMessage != nil)
    }

    @Test("no token means no request at all")
    func withoutToken() async {
        let server = FakeImportServer()
        let store = makeStore(server, token: nil)

        #expect(await store.readTransaction(ImportFixture.smallImage()) == nil)
        // This route spends money per call; an unauthenticated one must not
        // reach it even to be refused.
        #expect(server.calls == 0)
    }

    @Test("an oversized picture is shrunk before it is uploaded")
    func downscalesBeforeUpload() async {
        let server = FakeImportServer()
        let store = makeStore(server)

        _ = await store.readTransaction(ImportFixture.oversizedImage())

        let uploaded = Data(base64Encoded: server.lastBase64 ?? "")
        #expect(uploaded != nil)
        // The server re-checks this and its check is the control. What the
        // client's buys is not spending a phone's upload on a request already
        // certain to be refused.
        #expect((uploaded?.count ?? .max) <= ScreenshotImage.maxBytes)
    }
}

@Suite("Screenshot preparation")
struct ScreenshotImageTests {
    @Test("the long edge is brought down to the vendor's maximum")
    func downscales() async {
        let shrunk = await MainActor.run { ScreenshotImage.downscaled(ImportFixture.oversizedImage()) }

        #expect(max(shrunk.size.width, shrunk.size.height) == ScreenshotImage.maxLongEdge)
        // Aspect preserved: 4000×2000 is 2:1 and must stay 2:1, or the model
        // reads a squashed screen.
        #expect(shrunk.size.width == shrunk.size.height * 2)
    }

    @Test("a picture already inside the bound is left alone")
    func leavesSmallImagesUntouched() async {
        let small = await MainActor.run { ImportFixture.smallImage() }
        let result = await MainActor.run { ScreenshotImage.downscaled(small) }

        // Re-rendering it would cost quality for nothing.
        #expect(result.size == small.size)
    }
}

@Suite("Prefill note copy")
struct PrefillNoteCopyTests {
    private func note(
        kind: Kind,
        quantity: String? = nil,
        pricePerShare: String? = nil,
        feeCurrency: String? = nil,
        reason: String? = nil,
        currency: String? = nil,
        screenCurrency: String? = nil,
        shown: Shown? = nil
    ) -> PrefillNote {
        PrefillNote(
            currency: currency,
            feeCurrency: feeCurrency,
            kind: kind,
            pricePerShare: pricePerShare,
            quantity: quantity,
            reason: reason,
            screenCurrency: screenCurrency,
            shown: shown
        )
    }

    /// Listed rather than `allCases` — the generated enums are not
    /// `CaseIterable`. The real guard against a forgotten kind is the
    /// exhaustive switch in `PrefillNoteCopy`, which fails to COMPILE when the
    /// server adds one; this proves each of them actually says something.
    private static let everyKind: [Kind] = [
        .position, .sideAssumed, .sideUnknown, .feeConverted,
        .feeUnconverted, .priceCurrencyInferred, .currencyMismatch, .totalMismatch,
    ]

    @Test("every note kind produces a sentence")
    func allKindsSpeak() {
        // A note the phone renders as nothing is a disclosure the user never
        // sees — and every one of these exists because the app guessed.
        for kind in PrefillNoteCopyTests.everyKind {
            let sentence = PrefillNoteCopy.sentence(
                for: note(
                    kind: kind,
                    currency: "USD",
                    shown: Shown(from: "15.84", fromCurrency: "PLN", rate: "4.00", to: "3.96", toCurrency: "USD")
                )
            )
            #expect(sentence?.isEmpty == false, "no sentence for \(kind)")
        }
    }

    @Test("the position note names the figures it filled in")
    func positionNamesFigures() {
        let sentence = PrefillNoteCopy.sentence(
            for: note(kind: .position, quantity: "30", pricePerShare: "99.10")
        )

        // This is the ENTIRE mitigation for a screen that collapses several
        // fills into one line: it has to be recognisable.
        #expect(sentence?.contains("30") == true)
        #expect(sentence?.contains("99.10") == true)
    }

    @Test("the two unconverted-fee reasons read differently")
    func feeReasonsDiffer() {
        let noRate = PrefillNoteCopy.sentence(
            for: note(kind: .feeUnconverted, feeCurrency: "PLN", reason: "no-rate")
        )
        let unknownTarget = PrefillNoteCopy.sentence(
            for: note(kind: .feeUnconverted, feeCurrency: "PLN", reason: "unknown-target")
        )

        // Telling someone there is no rate while a rate is printed on the
        // screenshot in front of them is a confidently false explanation.
        #expect(noRate != unknownTarget)
        #expect(noRate?.contains("no rate") == true)
    }
}
