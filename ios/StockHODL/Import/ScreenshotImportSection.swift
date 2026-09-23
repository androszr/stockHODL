import PhotosUI
import SwiftUI

/// "Import from a screenshot" — the form section that reads a broker's screen.
///
/// The CAMERA is offered here, unlike on the web, and that is the point of
/// building this natively: a browser file input can only open the photo
/// library, so the web importer deliberately does not ask for the camera
/// (`transaction-import.tsx` says so in as many words). On a phone the natural
/// gesture is photographing the broker app you are already looking at.
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
    let onPicked: (UIImage) async -> Void
    /// Sentences the last read disclosed — every inference the app made and
    /// might have got wrong.
    var notes: [String] = []
    var readFields: [String] = []

    @State private var selection: PhotosPickerItem?
    @State private var isShowingCamera = false

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
                guard let image = UIImage(data: data) else {
                    store.reportPickerFailure("UIImage(data:) failed on \(data.count) bytes")
                    return
                }
                await onPicked(image)
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
    }
}

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
