import SwiftUI
import UIKit

/// The brand-icon tile — the native half of `src/components/holdings/ticker-logo.tsx`.
///
/// The monogram is a first-class rendering, not an error state: a `.WA`
/// holding will simply always look like this, and so will one whose bytes are
/// still in flight. The tile is a FIXED size that is reserved whether the
/// image arrives, fails, or never existed, so a row never reflows under a
/// thumb — the same guarantee the web tile makes, and the reason the web tile
/// exists at all.
///
/// The image cannot be fetched by a plain `AsyncImage`: the route is
/// bearer-guarded (the vendor's icon URL carries the API key, so the device is
/// never handed it), and `AsyncImage` has nowhere to put an Authorization
/// header. Hence the loader below.
struct TickerLogo: View {
    let symbol: String
    var size: CGFloat = 40
    /// How many leading symbol chars the monogram shows. Three, not four, on
    /// the holdings card: four semibold caps overflow a 32pt tile — the same
    /// contingency the web tile documents.
    var monogramChars: Int = 3

    @Environment(\.logoLoader) private var loader
    @State private var image: UIImage?
    /// Set only when the bytes arrived AFTER this tile appeared. A cache hit
    /// paints opaque on the first frame with no animation at all — a logo that
    /// fades on every scroll reads as a page that keeps reloading.
    @State private var faded = false

    var body: some View {
        ZStack {
            Text(monogram)
                .font(.system(size: size * 0.3, weight: .semibold))
                .foregroundStyle(Color(Tokens.textSecondary))
                .frame(width: size, height: size)
                .background(Color(Tokens.surface2))

            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .transition(.opacity)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.25))
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.25)
                .stroke(Color(Tokens.borderSubtle), lineWidth: 1)
        )
        // Decorative: the ticker is written beside it in text, and an
        // accessible name here would just say it twice.
        .accessibilityHidden(true)
        .task(id: symbol) { await load() }
    }

    private var monogram: String {
        // `BRK.B` monograms as "BRK", the same split the web tile makes: the
        // suffix is an exchange marker, not part of the brand.
        String((symbol.split(separator: ".").first ?? "").prefix(monogramChars))
    }

    private func load() async {
        if let hit = loader.cached(symbol) {
            image = hit
            return
        }
        image = nil
        guard let fresh = await loader.image(for: symbol) else { return }
        withAnimation(.easeIn(duration: 0.15)) {
            image = fresh
            faded = true
        }
    }
}

// MARK: - Loading

/// Where a tile gets its bytes. A protocol so that every screen stays
/// constructible from fakes — the loader needs a session token, and a view
/// that reached for the auth store to draw a logo would be untestable for the
/// sake of a 40-point square.
protocol LogoLoading: AnyObject, Sendable {
    /// A synchronous hit, or nil. Separate from `image(for:)` so an already
    /// decoded logo can paint on the first frame instead of fading in again.
    func cached(_ symbol: String) -> UIImage?
    func image(for symbol: String) async -> UIImage?
}

/// The default, and what every preview and test gets: no logos, all
/// monograms. A screen that cannot reach the network still looks finished.
final class NoLogoLoader: LogoLoading {
    func cached(_ symbol: String) -> UIImage? { nil }
    func image(for symbol: String) async -> UIImage? { nil }
}

/// Fetch once, keep forever — the brand-icon half of `RemoteImageCache`,
/// which is where the two-cache rationale and the locking live.
///
/// A thin wrapper rather than a typealias so `LogoLoading` stays the thing
/// views depend on: a screen asks for a logo by SYMBOL, and nothing above this
/// line needs to know that logos and news pictures share a cache underneath.
final class LogoLoader: LogoLoading, @unchecked Sendable {
    private let cache: RemoteImageCache

    init(
        disk: (any RemoteImageStoring)? = nil,
        fetch: @escaping @Sendable (String) async -> RemoteImageOutcome
    ) {
        // Namespaced so a purge of the brand icons cannot take the news
        // pictures with it, and so two keys that happen to be equal strings in
        // different caches cannot land on the same file.
        cache = RemoteImageCache(namespace: "logos", disk: disk, fetch: fetch)
    }

    func cached(_ symbol: String) -> UIImage? { cache.cached(symbol) }

    func image(for symbol: String) async -> UIImage? { await cache.image(for: symbol) }

    func purge() { cache.purge() }
}

extension EnvironmentValues {
    @Entry var logoLoader: any LogoLoading = NoLogoLoader()
}
