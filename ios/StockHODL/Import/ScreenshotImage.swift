import CoreGraphics
import Foundation
import UIKit

/// Turning a photo-library picture into something worth uploading.
///
/// The caps below mirror `src/lib/screenshots/image-upload.ts`, and the
/// mirroring is deliberate rather than sloppy: that module says in as many
/// words that the client's checks are a COURTESY and the server's are the
/// control. Nothing here can let a bad payload through — `decodeUploadedImage`
/// re-checks the size, re-sniffs the type and ignores whatever the client
/// claims. What these checks buy is not spending a phone's upload, a round
/// trip and part of a shared paid budget on a request already certain to fail.
enum ScreenshotImage {
    /// The vision service's documented long-edge maximum, px.
    static let maxLongEdge: CGFloat = 2576

    /// Hard cap on the ENCODED bytes. Base64 of this is ~3.4 MB.
    static let maxBytes = 2_621_440

    /// JPEG, stepping the quality down until it fits.
    ///
    /// JPEG rather than PNG: a screenshot of a broker's dark UI is mostly flat
    /// colour, and PNG of a 2576px screenshot routinely lands above the cap
    /// where JPEG at 0.8 lands an order of magnitude under it. Text legibility
    /// is what the vision model needs and JPEG at these qualities keeps it.
    private static let qualities: [CGFloat] = [0.8, 0.6, 0.45, 0.3]

    enum PreparationFailure: Error {
        /// The picker handed back something UIKit could not decode.
        case unreadable
        /// Still over the cap at the lowest quality — a panorama, or a photo
        /// of a screen rather than a screenshot.
        case tooLarge
    }

    /// Downscale, encode, base64. Returns the string the request body carries.
    static func prepare(_ image: UIImage) throws -> String {
        let scaled = downscaled(image)

        for quality in qualities {
            guard let data = scaled.jpegData(compressionQuality: quality) else {
                throw PreparationFailure.unreadable
            }
            if data.count <= maxBytes {
                return data.base64EncodedString()
            }
        }

        throw PreparationFailure.tooLarge
    }

    /// Long edge to `maxLongEdge`, aspect preserved. An image already inside
    /// the bound is returned untouched — re-rendering it would cost quality
    /// for nothing.
    static func downscaled(_ image: UIImage, longEdge: CGFloat = maxLongEdge) -> UIImage {
        let size = image.size
        let currentLongEdge = max(size.width, size.height)
        guard currentLongEdge > longEdge, currentLongEdge > 0 else { return image }

        let ratio = longEdge / currentLongEdge
        let target = CGSize(width: (size.width * ratio).rounded(), height: (size.height * ratio).rounded())

        // Scale 1 explicitly: the default is the screen's, which on a 3x
        // device would render a 3× bigger bitmap and undo the downscale.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true

        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
