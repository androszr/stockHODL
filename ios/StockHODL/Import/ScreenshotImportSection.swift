import SwiftUI
#if os(iOS)
    import PhotosUI
#else
    import AppKit
    import UniformTypeIdentifiers
#endif

/// "Import from a screenshot" — the form section that reads a broker's screen.
///
/// The CAMERA is offered here, unlike on the web, and that is the point of
/// building this natively: a browser file input can only open the photo
/// library, so the web importer deliberately does not ask for the camera
/// (`transaction-import.tsx` says so in as many words). On a phone the natural
/// gesture is photographing the broker app you are already looking at.
///
/// On the Mac there is no camera (it is compiled out): the picture arrives the
/// Mac way — dropped on the section, pasted, or chosen from a file panel
/// (plans/2026-09-28-native-mac-app-stage-1.md). Every source, on both
/// platforms, decodes through `ScreenshotImage.decode(_:)` into the same
/// `onPicked` the phone uses.
///
/// It has NO save path and imports no mutation. It fills in the form below it
/// — one Save button, one set of validation rules, one place a position can be
/// created. It also never resolves an instrument: the ticker or company name
/// goes into the search box and picking the company stays an explicit tap.
struct ScreenshotImportSection: View {
    let store: ImportStore
    /// What to do with a picked picture. The two forms read different
    /// endpoints, so the round trip belongs to the caller; this owns the
    /// picking, the camera and the disclosure.
    let onPicked: (PlatformImage) async -> Void
    /// Sentences the last read disclosed — every inference the app made and
    /// might have got wrong.
    var notes: [String] = []
    var readFields: [String] = []

    #if os(iOS)
        @State private var selection: PhotosPickerItem?
        @State private var isShowingCamera = false
    #else
        @State private var isChoosingFile = false
        @State private var isDropTargeted = false
    #endif

    var body: some View {
        Section("From a screenshot") {
            if store.isReading {
                HStack(spacing: 8) {
                    ProgressView().tint(Color(Tokens.textMuted))
                    Text("Reading the screenshot…")
                        .font(.subheadline)
                        .foregroundStyle(Color(Tokens.textSecondary))
                }
            } else {
                sources
            }

            if !readFields.isEmpty {
                // What was READ, named. A form that silently fills itself is a
                // form nobody checks; naming the fields tells the user exactly
                // which ones came from a guess.
                Text("Read from the picture: \(readFields.joined(separator: ", ")).")
                    .font(.caption2)
                    .foregroundStyle(Color(Tokens.textMuted))
            }

            ForEach(notes, id: \.self) { note in
                Text(note)
                    .font(.caption)
                    .foregroundStyle(Color(Tokens.textSecondary))
            }

            if let message = store.errorMessage {
                Text(message)
                    .font(.caption)
                    // Rate limiting is not the user's mistake and the money it
                    // protects is real, so it is a note rather than an error.
                    .foregroundStyle(Color(store.isRateLimited ? Tokens.textSecondary : Tokens.loss))
            }
        }
        #if os(iOS)
        .onChange(of: selection) { _, item in
            guard let item else { return }
            Task {
                defer { selection = nil }
                let data: Data?
                do {
                    data = try await item.loadTransferable(type: Data.self)
                } catch {
                    store.reportPickerFailure("loadTransferable threw: \(error)")
                    return
                }
                guard let data else {
                    store.reportPickerFailure("loadTransferable returned nil")
                    return
                }
                accept(data, from: "photo picker")
            }
        }
        .sheet(isPresented: $isShowingCamera) {
            ScreenshotCamera { image in
                isShowingCamera = false
                guard let image else { return }
                Task { await onPicked(image) }
            }
            .ignoresSafeArea()
        }
        #else
        .fileImporter(isPresented: $isChoosingFile, allowedContentTypes: [.image]) { result in
            chosen(result)
        }
        #endif
    }

    /// The one landing for every source's bytes: decode, or say the picture
    /// could not be loaded — never a silent nothing.
    private func accept(_ data: Data, from source: String) {
        guard let image = ScreenshotImage.decode(data) else {
            store.reportPickerFailure("\(source): could not decode \(data.count) bytes")
            return
        }
        Task { await onPicked(image) }
    }

    #if os(iOS)
        @ViewBuilder
        private var sources: some View {
            PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
                Label("Choose a screenshot", systemImage: "photo.on.rectangle")
            }

            if ScreenshotCamera.isAvailable {
                Button {
                    isShowingCamera = true
                } label: {
                    Label("Take a photo", systemImage: "camera")
                }
            }
        }
    #else
        /// Drop, paste (the button or Command-V while the area has focus) and
        /// a file panel. None of the three is a privacy gate; the sandbox
        /// grants the panel's file through the user-selected read entitlement.
        @ViewBuilder
        private var sources: some View {
            VStack(spacing: 6) {
                Image(systemName: "photo.on.rectangle")
                    .font(.title2)
                    .foregroundStyle(Color(isDropTargeted ? Tokens.accent : Tokens.textMuted))
                Text("Drop a screenshot here, or paste one")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textSecondary))
            }
            .frame(maxWidth: .infinity, minHeight: 88)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(
                        Color(isDropTargeted ? Tokens.accent : Tokens.borderSubtle),
                        style: StrokeStyle(lineWidth: 1, dash: [5, 4])
                    )
            )
            .contentShape(Rectangle())
            .focusable()
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Screenshot drop area")
            .dropDestination(for: Data.self) { items, _ in
                guard let data = items.first else { return false }
                accept(data, from: "drop")
                return true
            } isTargeted: { isDropTargeted = $0 }
            .onPasteCommand(of: [.image, .png, .jpeg, .tiff]) { _ in
                pasteFromPasteboard()
            }

            HStack {
                Button {
                    isChoosingFile = true
                } label: {
                    Label("Choose a file…", systemImage: "folder")
                }
                Button {
                    pasteFromPasteboard()
                } label: {
                    Label("Paste", systemImage: "doc.on.clipboard")
                }
            }
        }

        /// Whatever the pasteboard holds that is a picture: an image object
        /// (a copied file or a copy from Preview), else raw PNG or TIFF bytes.
        private func pasteFromPasteboard() {
            let board = NSPasteboard.general
            let data: Data?
            if let image = (board.readObjects(forClasses: [NSImage.self]) as? [NSImage])?.first {
                data = image.tiffRepresentation
            } else {
                data = board.data(forType: .png) ?? board.data(forType: .tiff)
            }
            guard let data else {
                store.reportPickerFailure("paste: no image on the pasteboard")
                return
            }
            accept(data, from: "paste")
        }

        private func chosen(_ result: Result<URL, Error>) {
            switch result {
            case let .success(url):
                // The panel's file is outside the sandbox until claimed.
                let claimed = url.startAccessingSecurityScopedResource()
                defer { if claimed { url.stopAccessingSecurityScopedResource() } }
                do {
                    accept(try Data(contentsOf: url), from: "file panel")
                } catch {
                    store.reportPickerFailure("file panel: \(error)")
                }
            case let .failure(error):
                store.reportPickerFailure("file panel: \(error)")
            }
        }
    #endif
}

#if os(iOS)
    /// The system camera, wrapped.
    ///
    /// `UIImagePickerController` rather than a `AVCapture` stack: this needs one
    /// still frame of a screen the user is pointing at, and every pixel of custom
    /// capture UI would be work spent making something worse than the camera app
    /// they already know.
    struct ScreenshotCamera: UIViewControllerRepresentable {
        let onCapture: (UIImage?) -> Void

        /// False in the simulator and on a device with no camera — the button is
        /// hidden rather than presented and then apologised for.
        static var isAvailable: Bool {
            UIImagePickerController.isSourceTypeAvailable(.camera)
        }

        func makeUIViewController(context: Context) -> UIImagePickerController {
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.delegate = context.coordinator
            return picker
        }

        func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

        func makeCoordinator() -> Coordinator {
            Coordinator(onCapture: onCapture)
        }

        final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
            private let onCapture: (UIImage?) -> Void

            init(onCapture: @escaping (UIImage?) -> Void) {
                self.onCapture = onCapture
            }

            func imagePickerController(
                _ picker: UIImagePickerController,
                didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
            ) {
                // `.original`, not `.editedImage`: no editing is offered, and the
                // edited key is absent when none happened.
                onCapture(info[.originalImage] as? UIImage)
            }

            func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
                onCapture(nil)
            }
        }
    }
#endif
