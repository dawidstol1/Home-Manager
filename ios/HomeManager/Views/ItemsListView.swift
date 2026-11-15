import SwiftUI

struct ItemsListView: View {
    @Environment(AppModel.self) private var model

    @State private var items: [Item] = []
    @State private var filter = ItemFilter()
    @State private var loaded = false
    @State private var showingForm = false
    @State private var error: String?

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
                ToolbarItem(placement: .primaryAction) {
                    Button { showingForm = true } label: { Label("Dodaj", systemImage: "plus") }
                        .disabled(!model.isConfigured)
                }
            }
            .sheet(isPresented: $showingForm) { ItemFormView(item: nil) }
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
