import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model

    enum Tab: Hashable { case dashboard, items, shopping, settings }
    @State private var tab: Tab = .dashboard

    var body: some View {
        TabView(selection: $tab) {
            DashboardView()
                .tabItem { Label("Pulpit", systemImage: "square.grid.2x2") }
                .tag(Tab.dashboard)
            ItemsListView()
                .tabItem { Label("Zasoby", systemImage: "shippingbox") }
                .tag(Tab.items)
            ShoppingListView()
                .tabItem { Label("Zakupy", systemImage: "cart") }
                .tag(Tab.shopping)
            SettingsView()
                .tabItem { Label("Ustawienia", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .onAppear {
            if !model.isConfigured { tab = .settings }
        }
        .task(id: model.revision) {
            guard model.isConfigured else { return }
            try? await model.loadDictionaries()
        }
    }
}
