import SwiftUI

struct ItemDetailView: View {
    let itemId: Int

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var item: Item?
    @State private var history: [HistoryEntry] = []
    @State private var amountText = "1"
    @State private var showingEdit = false
    @State private var confirmDelete = false
    @State private var fetchingImage = false
    @State private var error: String?

    var body: some View {
        Group {
            if let item {
                content(item)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(item?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edytuj") { showingEdit = true }
                    .disabled(item == nil)
            }
        }
        .sheet(isPresented: $showingEdit) {
            if let item { ItemFormView(item: item) }
        }
        .confirmationDialog("Usunąć „\(item?.name ?? "")”?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Usuń", role: .destructive) { delete() }
        }
        .task(id: model.revision) { await load() }
        .refreshable { await load() }
        .errorAlert($error)
    }

    private func content(_ item: Item) -> some View {
        List {
            Section {
                VStack(spacing: 4) {
                    ProductImage(item: item, size: 140)
                        .padding(.bottom, 6)
                    Text(item.quantityText)
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(item.isLow ? Color.orange : Color.primary)
                    if item.minQuantity > 0 {
                        Text("Stan minimalny: \(item.minQuantity.amount) \(item.unit)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)

                HStack {
                    Button { adjust(-1) } label: {
                        Label("Zużyj", systemImage: "minus.circle.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.orange)

                    TextField("Ilość", text: $amountText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.center)
                        .frame(width: 70)
                        .textFieldStyle(.roundedBorder)

                    Button { adjust(1) } label: {
                        Label("Dodaj", systemImage: "plus.circle.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.green)
                }

                Button(role: .destructive) { adjust(-1, reason: "wasted") } label: {
                    Label("Wyrzuć (zmarnowane)", systemImage: "trash").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderless)
                .disabled(item.quantity <= 0)
            }

            if let batches = item.batches, batches.count > 1 {
                Section {
                    ForEach(batches) { batch in
                        HStack {
                            Text("\(batch.quantity.amount) \(item.unit)").monospacedDigit()
                            Spacer()
                            Text(batch.expiresAt.flatMap(DateFormats.day.date(from:))?.formatted(date: .abbreviated, time: .omitted) ?? "bez daty")
                                .foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button("Wyrzuć", role: .destructive) { removeBatch(batch, reason: "wasted") }
                            Button("Zużyte") { removeBatch(batch, reason: "used") }.tint(.green)
                        }
                    }
                } header: {
                    Text("Partie")
                } footer: {
                    Text("Zużycie zdejmuje najpierw partię z najkrótszym terminem. Przesuń partię w lewo, aby ją zdjąć w całości.")
                }
            }

            Section("Szczegóły") {
                LabeledContent("Kategoria", value: item.category ?? "—")
                LabeledContent("Lokalizacja", value: item.location ?? "—")
                LabeledContent("Data ważności") {
                    HStack(spacing: 6) {
                        Text(item.expiryText ?? "—")
                        if let badge = item.expiryBadge {
                            Badge(text: badge, style: item.isExpired ? .danger : .warning)
                        }
                    }
                }
                if let barcode = item.barcode {
                    LabeledContent("Kod kreskowy") {
                        Text(barcode).monospacedDigit().textSelection(.enabled)
                    }
                }
                if let price = item.price {
                    LabeledContent("Cena jednostkowa", value: price.pln)
                    LabeledContent("Wartość", value: (price * item.quantity).pln)
                }
                if !item.notes.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Notatki").font(.caption).foregroundStyle(.secondary)
                        Text(item.notes)
                    }
                }
            }

            Section("Historia zmian") {
                if history.isEmpty {
                    Text("Brak zmian").foregroundStyle(.secondary)
                }
                ForEach(history) { entry in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(entry.note.isEmpty ? "Zmiana" : entry.note)
                            if let date = entry.date {
                                Text(date.formatted(date: .abbreviated, time: .shortened) + (entry.userName.map { " · \($0)" } ?? ""))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Text("\(entry.delta > 0 ? "+" : "")\(entry.delta.amount) \(item.unit)")
                            .monospacedDigit()
                            .fontWeight(.semibold)
                            .foregroundStyle(entry.delta > 0 ? Color.green : Color.red)
                    }
                }
            }

            if item.barcode != nil {
                Section {
                    Button {
                        fetchImage()
                    } label: {
                        Label(item.image == nil ? "Pobierz zdjęcie z internetu" : "Pobierz zdjęcie ponownie",
                              systemImage: "photo.badge.arrow.down")
                    }
                    .disabled(fetchingImage)
                    if item.image != nil {
                        Button("Usuń zdjęcie", role: .destructive) { removeImage() }
                    }
                } footer: {
                    Text("Zdjęcia pochodzą z bazy Open Food Facts (głównie żywność).")
                }
            }

            Section {
                Button("Usuń zasób", role: .destructive) { confirmDelete = true }
            }
        }
    }

    private func load() async {
        do {
            let api = try model.api
            async let i = api.item(itemId)
            async let h = api.history(itemId)
            let (loadedItem, loadedHistory) = try await (i, h)
            item = loadedItem
            history = loadedHistory
        } catch let APIError.server(status, _) where status == 404 {
            dismiss()
        } catch let error where !isCancellation(error) {
            self.error = error.localizedDescription
        } catch {}
    }

    private func removeBatch(_ batch: Batch, reason: String) {
        Task {
            do {
                item = try await model.api.removeBatch(batch.id, reason: reason)
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func adjust(_ sign: Double, reason: String? = nil) {
        guard let amount = parseDecimal(amountText), amount > 0 else {
            error = "Podaj dodatnią ilość"
            return
        }
        Task {
            do {
                item = try await model.api.adjust(itemId, delta: sign * amount, reason: reason)
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func fetchImage() {
        fetchingImage = true
        Task {
            defer { fetchingImage = false }
            do {
                let result = try await model.api.fetchImage(itemId)
                item = result.item
                if !result.found { error = "Nie znaleziono zdjęcia dla tego kodu w Open Food Facts." }
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func removeImage() {
        Task {
            do {
                item = try await model.api.removeImage(itemId)
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func delete() {
        Task {
            do {
                try await model.api.deleteItem(itemId)
                model.didChange()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
