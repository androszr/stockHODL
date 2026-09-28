#if os(macOS)
    import SwiftUI

    /// The Mac window's sidebar (plans/2026-09-28-native-mac-app-stage-1.md):
    /// every section the phone has, in one list, painted from tokens. Pure
    /// presentation — the selection and every action stay in `SignedInView`,
    /// which owns the same stores and stacks the phone's tab bar drives.
    struct MacSidebar: View {
        @Binding var selection: MacSidebarSection?

        var body: some View {
            List(selection: $selection) {
                Section {
                    ForEach(MacSidebarSection.allCases, id: \.self) { section in
                        Label {
                            Text(section.title)
                                .foregroundStyle(Color(Tokens.textPrimary))
                        } icon: {
                            Image(systemName: section.systemImage)
                                .foregroundStyle(Color(selection == section ? Tokens.accent : Tokens.textMuted))
                        }
                        .tag(section)
                    }
                } header: {
                    brand
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Color(Tokens.surface1))
            .tint(Color(Tokens.accent))
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 280)
        }

        private var brand: some View {
            HStack(spacing: 8) {
                BullMark()
                    .frame(width: 24, height: 24)
                Text("StockHODL")
                    .font(.headline)
                    .foregroundStyle(Color(Tokens.textPrimary))
            }
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
        }
    }
#endif
