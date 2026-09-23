import SwiftUI

/// Who is signed in, and the way out.
///
/// A screen rather than a button in a bar, because sign-out is destructive on
/// this app in a way it usually is not: the passkey stays, but the token, the
/// portfolio snapshot and every in-memory store go. Somewhere to say that
/// beats a control the thumb can reach by accident.
struct ProfileView: View {
    let user: SessionUser
    let appVersion: String
    let apiHost: String
    /// Optional so every preview and test can build this screen without a
    /// network: absent means the section is simply not drawn, which is also
    /// what a signed-out tree would want.
    var passkeys: PasskeysStore?
    /// The Settings screen's data. Optional for the same reason: absent means
    /// the row is not drawn, which is what a preview without a network wants.
    var settings: SettingsStore?
    /// The "Price alerts" toggle, shown on the Settings screen. Optional for
    /// the same preview/test reason as `settings`.
    var notifications: NotificationsStore?
    let onSignOut: () -> Void

    @State private var isConfirming = false
    @State private var pendingRemoval: PasskeyItem?
    @State private var isNamingPasskey = false
    @State private var newPasskeyName = "iPhone"

    var body: some View {
        List {
            Section("Signed in as") {
                Text(user.email)
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textPrimary))
            }

            if let passkeys {
                passkeySection(passkeys)
            }

            Section {
                Button("Sign out", role: .destructive) { isConfirming = true }
            } footer: {
                Text("Your passkey stays on this phone. Signing back in takes a tap.")
            }

            if let settings {
                Section {
                    // A PUSH rather than more sections here: what is behind it
                    // is diagnostics, and one of them costs a live vendor probe
                    // with a 5 s timeout. Profile opens on every tap of the top
                    // bar and must not wait on the vendor to do it.
                    NavigationLink {
                        SettingsView(store: settings, notifications: notifications)
                    } label: {
                        LabeledContent("Settings", value: "")
                    }
                }
            }

            Section("Build") {
                LabeledContent("Version", value: appVersion)
                // Worth surfacing: a Debug build on hardware talks to
                // production, and knowing which server answered is the first
                // question when a figure looks wrong.
                LabeledContent("Server", value: apiHost)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color(Tokens.surface0))
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .tokenSheetChrome()
        .task { await passkeys?.load() }
        .confirmationDialog(
            // Named, not "this passkey": with three devices enrolled an
            // unnamed dialog makes the confirmation a coin flip — the same
            // reason the web prompts for a name at registration.
            "Remove \(pendingRemoval?.displayName ?? "")?",
            isPresented: .init(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                guard let item = pendingRemoval else { return }
                pendingRemoval = nil
                Task { await passkeys?.remove(item) }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("That device will no longer be able to sign in.")
        }
        .alert(
            passkeys?.errorMessage ?? "",
            isPresented: .init(
                get: { passkeys?.errorMessage != nil },
                set: { if !$0 { passkeys?.dismissError() } }
            )
        ) {
            Button("OK") { passkeys?.dismissError() }
        }
        .alert("Name this device", isPresented: $isNamingPasskey) {
            TextField("Name", text: $newPasskeyName)
            Button("Add") {
                let name = newPasskeyName.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await passkeys?.add(name: name.isEmpty ? "iPhone" : name) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            "Sign out of StockHODL?",
            isPresented: $isConfirming,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive, action: onSignOut)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your saved portfolio is removed from this phone.")
        }
    }

    /// The enrolled keys. Add is a WebAuthn registration ceremony on this
    /// phone — same plugin endpoints the web used, session bearer plus the
    /// challenge cookie forwarded by hand.
    @ViewBuilder
    private func passkeySection(_ store: PasskeysStore) -> some View {
        Section {
            if store.items.isEmpty {
                // Only reachable as a load failure: a signed-in session
                // means at least one key exists.
                Text(store.isLoading ? "Loading…" : "No passkeys to show.")
                    .font(.subheadline)
                    .foregroundStyle(Color(Tokens.textMuted))
            } else {
                ForEach(store.items, id: \.id) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.displayName)
                            .font(.subheadline)
                            .foregroundStyle(Color(Tokens.textPrimary))
                        Text(item.subtitle)
                            .font(.caption)
                            .foregroundStyle(Color(Tokens.textMuted))
                    }
                    // Only when the SERVER says a removal is possible. The
                    // last key cannot go — this app is passkey-only, so
                    // deleting it ends access rather than degrading it — and
                    // an offered swipe that always fails is worse than no
                    // swipe at all.
                    .swipeActions(edge: .trailing) {
                        if store.canRemove {
                            Button(role: .destructive) {
                                pendingRemoval = item
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            Button {
                newPasskeyName = "iPhone"
                isNamingPasskey = true
            } label: {
                Label("Add a passkey", systemImage: "plus")
            }
        } header: {
            Text("Passkeys")
        } footer: {
            Text(
                store.canRemove
                    ? "Add one on every device you use."
                    : "This is your only passkey. Add another before removing it."
            )
        }
    }
}

extension Bundle {
    /// "1.2 (34)", or just the version when there is no build number to show.
    var displayVersion: String {
        let version = object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        guard let build = object(forInfoDictionaryKey: "CFBundleVersion") as? String else {
            return version
        }
        return "\(version) (\(build))"
    }
}
