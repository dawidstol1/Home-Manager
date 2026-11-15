import SwiftUI

/// Formularz dodawania (`item == nil`) lub edycji zasobu.
struct ItemFormView: View {
    let item: Item?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var categoryId: Int?
    @State private var locationId: Int?
    @State private var quantityText = "1"
    @State private var unit = "szt."
    @State private var minQuantityText = "0"
    @State private var priceText = ""
    @State private var hasExpiry = false
    @State private var expiry = Date.now
    @State private var notes = ""
    @State private var saving = false
    @State private var error: String?

    private static let units = ["szt.", "kg", "g", "l", "ml", "opak.", "rolka"]

    init(item: Item?) {
        self.item = item
        guard let item else { return }
        _name = State(initialValue: item.name)
        _categoryId = State(initialValue: item.categoryId)
        _locationId = State(initialValue: item.locationId)
        _quantityText = State(initialValue: item.quantity.amount)
        _unit = State(initialValue: item.unit)
        _minQuantityText = State(initialValue: item.minQuantity.amount)
        _priceText = State(initialValue: item.price?.amount ?? "")
        if let date = item.expiresAt.flatMap(DateFormats.day.date(from:)) {
            _hasExpiry = State(initialValue: true)
            _expiry = State(initialValue: date)
        }
        _notes = State(initialValue: item.notes)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Nazwa", text: $name)
                        .textInputAutocapitalization(.sentences)
                    Picker("Kategoria", selection: $categoryId) {
                        Text("— brak —").tag(Int?.none)
                        ForEach(model.categories) { Text($0.name).tag(Optional($0.id)) }
                    }
                    Picker("Lokalizacja", selection: $locationId) {
                        Text("— brak —").tag(Int?.none)
                        ForEach(model.locations) { Text($0.name).tag(Optional($0.id)) }
                    }
                }

                Section("Ilość") {
                    LabeledContent("Ilość") {
                        TextField("0", text: $quantityText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Jednostka")
                        Spacer()
                        TextField("szt.", text: $unit)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 100)
                        Menu {
                            ForEach(Self.units, id: \.self) { u in Button(u) { unit = u } }
                        } label: {
                            Image(systemName: "chevron.up.chevron.down")
                        }
                    }
                    LabeledContent("Stan minimalny") {
                        TextField("0", text: $minQuantityText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                }

                Section {
                    LabeledContent("Cena jedn. (zł)") {
                        TextField("opcjonalnie", text: $priceText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    Toggle("Data ważności", isOn: $hasExpiry.animation())
                    if hasExpiry {
                        DatePicker("Ważne do", selection: $expiry, displayedComponents: .date)
                            .environment(\.locale, Locale(identifier: "pl_PL"))
                    }
                }

                Section("Notatki") {
                    TextField("Notatki", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
                }
            }
            .navigationTitle(item == nil ? "Nowy zasób" : "Edytuj zasób")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zapisz", action: save)
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .interactiveDismissDisabled(saving)
            .errorAlert($error)
        }
    }

    private func makeInput() throws -> ItemInput {
        struct FormError: LocalizedError {
            let errorDescription: String?
        }
        guard let quantity = parseDecimal(quantityText), quantity >= 0 else {
            throw FormError(errorDescription: "Ilość musi być nieujemną liczbą")
        }
        let minQuantity: Double
        if minQuantityText.trimmingCharacters(in: .whitespaces).isEmpty {
            minQuantity = 0
        } else if let value = parseDecimal(minQuantityText), value >= 0 {
            minQuantity = value
        } else {
            throw FormError(errorDescription: "Stan minimalny musi być nieujemną liczbą")
        }
        var price: Double?
        if !priceText.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let value = parseDecimal(priceText), value >= 0 else {
                throw FormError(errorDescription: "Cena musi być nieujemną liczbą")
            }
            price = value
        }

        var input = ItemInput()
        input.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        input.categoryId = categoryId
        input.locationId = locationId
        input.quantity = quantity
        input.unit = unit.trimmingCharacters(in: .whitespaces).isEmpty ? "szt." : unit
        input.minQuantity = minQuantity
        input.price = price
        input.expiresAt = hasExpiry ? DateFormats.day.string(from: expiry) : nil
        input.notes = notes
        return input
    }

    private func save() {
        let input: ItemInput
        do {
            input = try makeInput()
        } catch {
            self.error = error.localizedDescription
            return
        }
        saving = true
        Task {
            defer { saving = false }
            do {
                let api = try model.api
                if let item {
                    _ = try await api.updateItem(item.id, input)
                } else {
                    _ = try await api.createItem(input)
                }
                model.didChange()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
