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
        .onChange(of: model.isConfigured) { _, configured in
            if !configured { tab = .settings }
        }
        .task(id: model.serverAddress) {
            guard model.isConfigured else { return }
            await model.checkAuth()
        }
        .task(id: model.revision) {
            guard model.isConfigured, model.authState == .loggedIn else { return }
            try? await model.loadDictionaries()
        }
        // Ekran logowania, gdy serwer jest ustawiony, ale nikt nie jest zalogowany.
        .fullScreenCover(isPresented: Binding(
            get: { model.isConfigured && (model.authState == .needsLogin || model.authState == .needsSetup) },
            set: { _ in }
        )) {
            LoginView()
                .environment(model)
                .interactiveDismissDisabled()
                .overlay(alignment: .topLeading) {
                    // Pozwala zmienić adres serwera, gdy wpisano zły.
                    Button("Zmień serwer") { model.setServerAddress("") }
                        .padding()
                }
        }
    }
}
