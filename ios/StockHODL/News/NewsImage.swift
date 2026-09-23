import SwiftUI
import UIKit

/// A picture that arrives over a bearer-guarded route.
///
/// Not `AsyncImage`: every news asset is fetched from OUR origin with an
/// Authorization header (the publisher host is never named on the client), and
/// `AsyncImage` has nowhere to put one. Same reason `TickerLogo` has its own
/// loader.
///
/// A missing picture is ORDINARY here, not an error — plenty of publishers
/// have no usable image and the proxy answers 404 for all of them. So the
/// placeholder is a plain surface, never an error glyph, and the caller
/// decides whether to reserve space for one at all.
struct NewsImage<Placeholder: View>: View {
    let id: String
    let loader: RemoteImageCache
    let contentMode: ContentMode
    @ViewBuilder let placeholder: () -> Placeholder

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            placeholder()
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .transition(.opacity)
            }
        }
        .clipped()
        // Decorative: the headline beside it is the accessible content, and a
        // hero image has no alt text on this wire.
        .accessibilityHidden(true)
        .task(id: id) { await load() }
    }

    private func load() async {
        // A cache hit paints opaque on the first frame — an image that fades
        // on every scroll reads as a page that keeps reloading.
        if let hit = loader.cached(id) {
            image = hit
            return
        }
        image = nil
        guard let fresh = await loader.image(for: id) else { return }
        withAnimation(.easeIn(duration: 0.15)) { image = fresh }
    }
}
