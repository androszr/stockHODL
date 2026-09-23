import Foundation
import Observation
import UIKit

/// Reading a broker screenshot, for whichever form asked.
///
/// It owns exactly one thing: the round trip from a picked picture to a
/// prefill, and the vocabulary for every way that goes wrong. It writes
/// NOTHING — the form below it still has one Save button, one set of
/// validation rules and one place a position can be created. That is the same
/// division `transaction-import.tsx` makes on the web and it is the reason
/// this feature cannot invent a transaction nobody read.
///
/// Failures are worth their own type because they are not interchangeable.
/// "Wait a few minutes" and "try another picture" send the user to different
/// places, and getting that wrong wastes either their time or their money.
@Observable
@MainActor
final class ImportStore {
    private(set) var isReading = false
    private(set) var errorMessage: String?
    /// Set when the failure is the shared paid budget rather than the picture,
    /// so the surface can say "wait" instead of "try another screenshot".
    private(set) var isRateLimited = false

    private let client: ImportClient
    private let tokenProvider: @MainActor () -> String?

    init(client: ImportClient, tokenProvider: @escaping @MainActor () -> String?) {
        self.client = client
        self.tokenProvider = tokenProvider
    }

    /// Last-request-wins across prepare→upload: a slow read of an abandoned
    /// picture must never install itself over a newer one. The web importer
    /// carries the same guard (`seqRef`) for the same reason — on a phone the
    /// picker makes double-picking easy.
    private var sequence = 0

    func readTransaction(_ image: UIImage) async -> TransactionImportResponse? {
        await read(image) { base64, token in
            try await self.client.transaction(imageBase64: base64, token: token)
        }
    }

    func readOption(_ image: UIImage) async -> OptionImportResponse? {
        await read(image) { base64, token in
            try await self.client.option(imageBase64: base64, token: token)
        }
    }

    private func read<T>(
        _ image: UIImage,
        _ call: @escaping (String, String) async throws -> T
    ) async -> T? {
        guard let token = tokenProvider() else {
            #if DEBUG
                print("[import] no session token available; refusing to read")
            #endif
            return nil
        }

        sequence += 1
        let mine = sequence
        #if DEBUG
            print("[import] #\(mine) starting read, source image \(Int(image.size.width))x\(Int(image.size.height))")
        #endif

        isReading = true
        isRateLimited = false
        errorMessage = nil
        defer { if mine == sequence { isReading = false } }

        // Downscale and encode OFF the main actor: a 12-megapixel screenshot
        // re-rendered on the main thread drops frames on the sheet that is
        // still animating in.
        let base64: String
        do {
            base64 = try await Task.detached(priority: .userInitiated) {
                try ScreenshotImage.prepare(image)
            }.value
            #if DEBUG
                print("[import] #\(mine) prepared \(base64.count) base64 chars")
            #endif
        } catch ScreenshotImage.PreparationFailure.tooLarge {
            #if DEBUG
                print("[import] #\(mine) image too large even after downscale")
            #endif
            errorMessage = "That picture is too big even after shrinking it. Try a screenshot rather than a photo."
            return nil
        } catch {
            #if DEBUG
                print("[import] #\(mine) image prep failed: \(error)")
            #endif
            errorMessage = "That file could not be read as an image."
            return nil
        }

        do {
            let result = try await call(base64, token)
            // A newer pick has already started; this answer is stale and must
            // not fill in a form the user has moved on from.
            guard mine == sequence else {
                #if DEBUG
                    print("[import] #\(mine) succeeded but was superseded by #\(sequence); discarding")
                #endif
                return nil
            }
            #if DEBUG
                print("[import] #\(mine) succeeded")
            #endif
            return result
        } catch let APIError.http(status, message) {
            guard mine == sequence else { return nil }
            isRateLimited = status == 429
            #if DEBUG
                print("[import] #\(mine) server refused: status=\(status) message=\(message ?? "nil")")
            #endif
            // The routes write a sentence per failure and it is better than
            // anything generic this side could invent — "nothing readable was
            // found" sends the user to a different action than "unavailable".
            errorMessage = message ?? "Could not read that screenshot."
            return nil
        } catch let APIError.decoding(underlying) {
            guard mine == sequence else { return nil }
            #if DEBUG
                print("[import] #\(mine) response did not match the expected shape: \(underlying)")
            #endif
            errorMessage = "Could not read that screenshot."
            return nil
        } catch let APIError.transport(underlying) {
            guard mine == sequence else { return nil }
            #if DEBUG
                print("[import] #\(mine) network transport failed: \(underlying)")
            #endif
            errorMessage = "Could not read that screenshot."
            return nil
        } catch {
            guard mine == sequence else { return nil }
            #if DEBUG
                print("[import] #\(mine) read failed: \(error)")
            #endif
            errorMessage = "Could not read that screenshot."
            return nil
        }
    }

    func dismissError() {
        errorMessage = nil
        isRateLimited = false
    }

    /// The picker/camera path never reaches `read` — a bad `Data` or a
    /// `UIImage` decode failure happens in `ScreenshotImportSection` itself,
    /// outside this store. It reports through here anyway so both failure
    /// paths log to the same place and show the same message, rather than
    /// leaving the picker silently dropping the pick on the floor.
    func reportPickerFailure(_ reason: String) {
        #if DEBUG
            print("[import] picker failed: \(reason)")
        #endif
        errorMessage = "Could not load that picture."
    }
}
