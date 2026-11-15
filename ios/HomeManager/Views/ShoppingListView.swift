import SwiftUI

struct ShoppingListView: View {
    @Environment(AppModel.self) private var model

    @State private var entries: [ShoppingItem] = []
    @State private var loaded = false
    @State private var error: String?

    private var shareText: String {
        entries.map { "- \($0.item.name): \($0.toBuy.amount) \($0.item.unit)" }.joined(separator: "\n")
    }

    var body: some View {
        NavigationStack {
            Group {
                if !model.isConfigured {
                    NotConfiguredView()
                } else {
                    list
                }
            }
            .navigationTitle("Lista zakupów")
            .toolbar {
                if !entries.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: "Lista zakupów:\n" + shareText) {
                            Label("Udostępnij", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
            .task(id: model.revision) { await load() }
            .errorAlert($error)
        }
    }

    private var list: some View {
        List {
            if !entries.isEmpty {
                Section {
                    ForEach(entries) { entry in
                        row(entry)
                    }
                } footer: {
                    Text("Pozycje, których stan spadł do poziomu minimalnego lub niżej.")
                }
            }
        }
        .overlay {
            if loaded && entries.isEmpty {
                ContentUnavailableView(
                    "Lista zakupów jest pusta",
                    systemImage: "cart",
                    description: Text("Wszystkie zapasy są powyżej stanu minimalnego 🎉")
                )
            }
        }
        .refreshable { await load() }
    }

    private func row(_ entry: ShoppingItem) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.item.name).fontWeight(.semibold)
                Text("\(entry.item.location ?? "bez lokalizacji") · jest \(entry.item.quantityText)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("kup \(entry.toBuy.amount) \(entry.item.unit)")
                    .font(.callout)
                    .monospacedDigit()
                Button("Kupione") { markBought(entry) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
    }

    private func load() async {
        guard model.isConfigured else { return }
        do {
            entries = try await model.api.shoppingList()
            loaded = true
        } catch let error where !isCancellation(error) {
            self.error = error.localizedDescription
        } catch {}
    }

    private func markBought(_ entry: ShoppingItem) {
        Task {
            do {
                _ = try await model.api.adjust(entry.id, delta: entry.toBuy, note: "Zakup")
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
