import CoreGraphics
import Foundation
#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

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
        /// The picker handed back something the platform could not decode.
        case unreadable
        /// Still over the cap at the lowest quality — a panorama, or a photo
        /// of a screen rather than a screenshot.
        case tooLarge
    }

    /// The one decoder every source goes through: the phone's photo picker,
    /// and the Mac's drop, paste and file picker. Nil when the bytes are not
    /// an image the platform can read.
    static func decode(_ data: Data) -> PlatformImage? {
        guard !data.isEmpty else { return nil }
        return PlatformImage(data: data)
    }

    /// Downscale, encode, base64. Returns the string the request body carries.
    static func prepare(_ image: PlatformImage) throws -> String {
        let scaled = downscaled(image)

        for quality in qualities {
            guard let data = jpeg(scaled, quality: quality) else {
                throw PreparationFailure.unreadable
            }
            if data.count <= maxBytes {
                return data.base64EncodedString()
            }
        }

        throw PreparationFailure.tooLarge
    }

    #if canImport(UIKit)
        private static func jpeg(_ image: UIImage, quality: CGFloat) -> Data? {
            image.jpegData(compressionQuality: quality)
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
    #elseif canImport(AppKit)
        private static func jpeg(_ image: NSImage, quality: CGFloat) -> Data? {
            guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                return nil
            }
            return NSBitmapImageRep(cgImage: cgImage)
                .representation(using: .jpeg, properties: [.compressionFactor: quality])
        }

        /// The Mac twin of the UIKit path. Measured in PIXELS, not points: a
        /// Retina screenshot is a 144-dpi file whose `NSImage.size` is half
        /// its pixel size, and the vision cap is in pixels. Drawn at scale 1
        /// into an opaque bitmap, like the phone's renderer.
        static func downscaled(_ image: NSImage, longEdge: CGFloat = maxLongEdge) -> NSImage {
            guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                return image
            }
            let width = CGFloat(cgImage.width)
            let height = CGFloat(cgImage.height)
            let currentLongEdge = max(width, height)
            guard currentLongEdge > longEdge, currentLongEdge > 0 else { return image }

            let ratio = longEdge / currentLongEdge
            let targetWidth = Int((width * ratio).rounded())
            let targetHeight = Int((height * ratio).rounded())

            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(
                      data: nil,
                      width: targetWidth,
                      height: targetHeight,
                      bitsPerComponent: 8,
                      bytesPerRow: 0,
                      space: space,
                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                  )
            else { return image }

            context.interpolationQuality = .high
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
            guard let scaled = context.makeImage() else { return image }
            return NSImage(cgImage: scaled, size: NSSize(width: targetWidth, height: targetHeight))
        }
    #endif
}
