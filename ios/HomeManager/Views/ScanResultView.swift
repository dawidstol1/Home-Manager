import SwiftUI

/// Wynik skanowania znanego kodu: szybkie zużycie / uzupełnienie bez szukania na liście.
struct ScanResultView: View {
    let barcode: String
    let onAddNew: (ItemInput) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var items: [Item]
    @State private var editing: Item?
    @State private var error: String?

    init(barcode: String, items: [Item], onAddNew: @escaping (ItemInput) -> Void) {
        self.barcode = barcode
        self.onAddNew = onAddNew
        _items = State(initialValue: items)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(items) { item in
                        row(item)
                    }
                } footer: {
                    Text("Kod: \(barcode)")
                }

                Section {
                    Button {
                        var prefill = ItemInput()
                        prefill.barcode = barcode
                        prefill.name = items.first?.name ?? ""
                        prefill.categoryId = items.first?.categoryId
                        prefill.unit = items.first?.unit ?? "szt."
                        onAddNew(prefill)
                        dismiss()
                    } label: {
                        Label("Dodaj jako nową pozycję", systemImage: "plus.circle")
                    }
                }
            }
            .navigationTitle(items.count == 1 ? items[0].name : "Znaleziono \(items.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Gotowe") { dismiss() }
                }
            }
            .sheet(item: $editing) { ItemFormView(item: $0) }
            .task(id: model.revision) { await reload() }
            .errorAlert($error)
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ item: Item) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name).fontWeight(.semibold)
                Text([item.location, item.expiryText.map { "ważne do \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(item.quantityText)
                .monospacedDigit()
                .foregroundStyle(item.isLow ? Color.orange : Color.primary)
            Group {
                Button { adjust(item, by: -1) } label: { Image(systemName: "minus.circle.fill") }
                    .tint(.orange)
                    .disabled(item.quantity < 1)
                    .accessibilityLabel("Zużyj 1")
                Button { adjust(item, by: 1) } label: { Image(systemName: "plus.circle.fill") }
                    .tint(.green)
                    .accessibilityLabel("Dodaj 1")
            }
            .font(.title2)
        }
        .buttonStyle(.borderless)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Edytuj") { editing = item }
        }
        .swipeActions {
            Button("Edytuj") { editing = item }
        }
    }

    private func adjust(_ item: Item, by delta: Double) {
        Task {
            do {
                let updated = try await model.api.adjust(item.id, delta: delta, note: "Skan")
                if let index = items.firstIndex(where: { $0.id == updated.id }) {
                    items[index] = updated
                }
                UISelectionFeedbackGenerator().selectionChanged()
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func reload() async {
        guard let fresh = try? await model.api.lookupBarcode(barcode), !fresh.items.isEmpty else { return }
        items = fresh.items
    }
}
