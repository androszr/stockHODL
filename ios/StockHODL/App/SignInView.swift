import SwiftUI

/// The whole of sign-in: passkey as the main action, emergency password
/// tucked behind a secondary control on the same screen.
///
/// Copy keeps the deliberately uninformative error. There is no recovery-mode
/// probe — the emergency control is always reachable, and when recovery is
/// off Better Auth refuses with the same generic sentence.
struct SignInView: View {
    let store: AuthStore

    @State private var showEmergency = false
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        ZStack {
            Color(Tokens.surface0).ignoresSafeArea()

            ScrollView {
                VStack(spacing: 16) {
                    Spacer(minLength: 48)

                    BullMark().frame(width: 96)

                    Text("StockHODL")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Color(Tokens.textPrimary))

                    Spacer(minLength: 48)

                    Button {
                        Task { await store.signIn() }
                    } label: {
                        HStack(spacing: 8) {
                            if store.state == .signingIn && !showEmergency {
                                ProgressView().tint(Color(Tokens.accentContrast))
                            } else {
                                Image(systemName: "person.badge.key.fill")
                            }
                            Text(store.state == .signingIn && !showEmergency
                                 ? "Signing in…"
                                 : "Sign in with passkey")
                                .font(.callout.weight(.medium))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(Tokens.accent), in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(Color(Tokens.accentContrast))
                    }
                    .disabled(store.state == .signingIn)

                    if let message = store.errorMessage {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(Color(Tokens.loss))
                            .multilineTextAlignment(.center)
                    } else {
                        Text("Face ID and the passkey already on this phone.")
                            .font(.footnote)
                            .foregroundStyle(Color(Tokens.textMuted))
                            .multilineTextAlignment(.center)
                    }

                    Button {
                        withAnimation { showEmergency.toggle() }
                    } label: {
                        Text("Emergency password")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Color(Tokens.textMuted))
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .disabled(store.state == .signingIn)
                    .accessibilityHint("Reveals email and password for recovery sign-in")

                    if showEmergency {
                        emergencyForm
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var emergencyForm: some View {
        VStack(spacing: 12) {
            TextField("Email", text: $email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(Color(Tokens.textPrimary))
                .disabled(store.state == .signingIn)

            SecureField("Password", text: $password)
                .textContentType(.password)
                .padding(12)
                .background(Color(Tokens.surface1), in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(Color(Tokens.textPrimary))
                .disabled(store.state == .signingIn)

            Button {
                Task { await store.signInWithPassword(email: email, password: password) }
            } label: {
                HStack(spacing: 8) {
                    if store.state == .signingIn {
                        ProgressView().tint(Color(Tokens.accentContrast))
                    }
                    Text(store.state == .signingIn ? "Signing in…" : "Sign in")
                        .font(.callout.weight(.medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color(Tokens.surface2), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(Color(Tokens.textPrimary))
            }
            .disabled(store.state == .signingIn || email.isEmpty || password.isEmpty)
        }
    }
}
