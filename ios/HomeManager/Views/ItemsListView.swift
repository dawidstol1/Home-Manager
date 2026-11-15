import SwiftUI

struct ItemsListView: View {
    @Environment(AppModel.self) private var model

    @State private var items: [Item] = []
    @State private var filter = ItemFilter()
    @State private var loaded = false
    @State private var sheet: ActiveSheet?
    @State private var pendingCode: String?
    @State private var pendingNewItem: ItemInput?
    @State private var resolvingScan = false
    @State private var error: String?

    /// Jeden arkusz naraz: nowy zasób, skaner albo wynik skanowania.
    enum ActiveSheet: Identifiable {
        case newItem(ItemInput?)
        case scanner
        case scanResult(barcode: String, items: [Item])

        var id: String {
            switch self {
            case .newItem: "new"
            case .scanner: "scanner"
            case let .scanResult(barcode, _): "result-\(barcode)"
            }
        }
    }

    private struct LoadKey: Equatable {
        let filter: ItemFilter
        let revision: Int
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
            .navigationTitle("Zasoby")
            .navigationDestination(for: Int.self) { ItemDetailView(itemId: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { filterMenu }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { sheet = .scanner } label: { Label("Skanuj", systemImage: "barcode.viewfinder") }
                        .disabled(!model.isConfigured || resolvingScan)
                    Button { sheet = .newItem(nil) } label: { Label("Dodaj", systemImage: "plus") }
                        .disabled(!model.isConfigured)
                }
            }
            .overlay {
                if resolvingScan {
                    ProgressView("Szukam produktu…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .sheet(item: $sheet, onDismiss: afterSheetDismissed) { sheet in
                switch sheet {
                case let .newItem(prefill):
                    ItemFormView(item: nil, prefill: prefill)
                case .scanner:
                    BarcodeScannerSheet { code in pendingCode = code }
                case let .scanResult(barcode, items):
                    ScanResultView(barcode: barcode, items: items) { prefill in pendingNewItem = prefill }
                }
            }
            .task(id: LoadKey(filter: filter, revision: model.revision)) {
                // Krótka zwłoka – nie odpytujemy serwera przy każdym znaku wyszukiwania.
                if loaded { try? await Task.sleep(for: .milliseconds(250)) }
                guard !Task.isCancelled else { return }
                await load()
            }
            .errorAlert($error)
        }
    }

    private var list: some View {
        List {
            ForEach(items) { item in
                NavigationLink(value: item.id) { ItemRow(item: item) }
                    .swipeActions(edge: .leading) {
                        Button { adjust(item, by: 1) } label: { Label("+1", systemImage: "plus") }
                            .tint(.green)
                        Button { adjust(item, by: -1) } label: { Label("−1", systemImage: "minus") }
                            .tint(.orange)
                            .disabled(item.quantity < 1)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { delete(item) } label: { Label("Usuń", systemImage: "trash") }
                    }
            }
        }
        .overlay {
            if loaded && items.isEmpty {
                if filter == ItemFilter() {
                    ContentUnavailableView {
                        Label("Brak zasobów", systemImage: "shippingbox")
                    } description: {
                        Text("Dodaj pierwszy zasób przyciskiem +.")
                    }
                } else {
                    ContentUnavailableView.search
                }
            }
        }
        .searchable(text: $filter.query, prompt: "Szukaj")
        .refreshable { await load() }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Status", selection: $filter.status) {
                ForEach(StatusFilter.allCases) { Text($0.title).tag($0) }
            }
            Picker("Kategoria", selection: $filter.categoryId) {
                Text("Wszystkie kategorie").tag(Int?.none)
                ForEach(model.categories) { Text($0.name).tag(Optional($0.id)) }
            }
            Picker("Lokalizacja", selection: $filter.locationId) {
                Text("Wszystkie lokalizacje").tag(Int?.none)
                ForEach(model.locations) { Text($0.name).tag(Optional($0.id)) }
            }
            if filter != ItemFilter(query: filter.query) {
                Button("Wyczyść filtry", role: .destructive) {
                    filter = ItemFilter(query: filter.query)
                }
            }
        } label: {
            let active = filter != ItemFilter(query: filter.query)
            Label("Filtry", systemImage: active ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
    }

    // MARK: - Skanowanie

    /// Kolejny arkusz otwieramy dopiero po zamknięciu poprzedniego.
    private func afterSheetDismissed() {
        if let code = pendingCode {
            pendingCode = nil
            Task { await resolveScan(code) }
        } else if let prefill = pendingNewItem {
            pendingNewItem = nil
            sheet = .newItem(prefill)
        }
    }

    private func resolveScan(_ code: String) async {
        resolvingScan = true
        defer { resolvingScan = false }
        do {
            let result = try await model.api.lookupBarcode(code)
            if !result.items.isEmpty {
                sheet = .scanResult(barcode: result.barcode, items: result.items)
                return
            }
            var prefill = ItemInput()
            prefill.barcode = result.barcode
            if let product = result.product {
                prefill.name = product.name
                prefill.categoryId = model.categories.first { $0.name == product.categoryHint }?.id
                if let quantity = product.quantity { prefill.notes = "Opakowanie: \(quantity)" }
            }
            sheet = .newItem(prefill)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        guard model.isConfigured else { return }
        do {
            items = try await model.api.items(filter: filter)
            loaded = true
        } catch let error where !isCancellation(error) {
            self.error = error.localizedDescription
        } catch {}
    }

    private func adjust(_ item: Item, by delta: Double) {
        Task {
            do {
                _ = try await model.api.adjust(item.id, delta: delta)
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func delete(_ item: Item) {
        Task {
            do {
                try await model.api.deleteItem(item.id)
                items.removeAll { $0.id == item.id }
                model.didChange()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
