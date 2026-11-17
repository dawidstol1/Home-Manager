import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    @State private var address = ""
    @State private var status: ConnectionStatus = .unknown
    @FocusState private var addressFocused: Bool

    enum ConnectionStatus: Equatable {
        case unknown, checking, ok(Int), failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("np. 192.168.1.10:3000", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($addressFocused)
                        .onSubmit(connect)
                    Button("Zapisz i połącz", action: connect)
                        .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || status == .checking)
                    statusRow
                } header: {
                    Text("Serwer")
                } footer: {
                    Text("Adres serwera Home-Manager, np. `https://zasoby.example.pl` albo `192.168.1.30:3000` w sieci domowej.")
                }

                if let user = model.user {
                    Section("Konto") {
                        LabeledContent("Zalogowano jako", value: user.name)
                        LabeledContent("Login", value: user.login)
                        LabeledContent("Rola", value: user.isAdmin ? "Administrator" : "Domownik")
                        Button("Wyloguj", role: .destructive) {
                            Task { await model.logout() }
                        }
                    }
                }

                if model.isConfigured {
                    Section("Słowniki") {
                        ForEach(DictKind.allCases) { kind in
                            NavigationLink {
                                DictListView(kind: kind)
                            } label: {
                                LabeledContent(kind.title, value: "\(model.entries(kind).count)")
                            }
                        }
                    }
                }

                Section("Aplikacja") {
                    LabeledContent("Wersja", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                }
            }
            .navigationTitle("Ustawienia")
            .onAppear {
                if address.isEmpty { address = model.serverAddress }
            }
            .task {
                if model.isConfigured { await check() }
            }
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch status {
        case .unknown:
            EmptyView()
        case .checking:
            HStack { ProgressView(); Text("Łączenie…").foregroundStyle(.secondary) }
        case let .ok(count):
            Label(count < 0 ? "Połączono – zaloguj się" : "Połączono · \(count) zasobów", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
        }
    }

    private func connect() {
        addressFocused = false
        guard APIClient(serverAddress: address) != nil else {
            status = .failed(APIError.invalidServerURL.localizedDescription)
            return
        }
        model.setServerAddress(address)
        Task { await check() }
    }

    private func check() async {
        status = .checking
        do {
            await model.checkAuth()
            guard model.authState == .loggedIn else {
                status = model.authState == .unknown ? .failed("Brak połączenia z serwerem") : .ok(-1)
                return
            }
            let stats = try await model.api.stats()
            try await model.loadDictionaries()
            status = .ok(stats.totalItems)
        } catch {
            status = .failed(error.localizedDescription)
        }
    }
}

/// Lista kategorii lub lokalizacji z możliwością dodawania i usuwania.
struct DictListView: View {
    let kind: DictKind

    @Environment(AppModel.self) private var model
    @State private var showingAdd = false
    @State private var newName = ""
    @State private var error: String?

    var body: some View {
        List {
            ForEach(model.entries(kind)) { entry in
                LabeledContent(entry.name, value: "\(entry.itemCount ?? 0)")
            }
            .onDelete(perform: delete)
        }
        .overlay {
            if model.entries(kind).isEmpty {
                ContentUnavailableView("Brak pozycji", systemImage: "tray")
            }
        }
        .navigationTitle(kind.title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newName = ""; showingAdd = true } label: { Label("Dodaj", systemImage: "plus") }
            }
            ToolbarItem(placement: .topBarTrailing) { EditButton() }
        }
        .alert("Nowa \(kind.singular)", isPresented: $showingAdd) {
            TextField("Nazwa", text: $newName)
            Button("Anuluj", role: .cancel) {}
            Button("Dodaj", action: add)
        }
        .refreshable { try? await model.loadDictionaries() }
        .errorAlert($error)
    }

    private func add() {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        Task {
            do {
                _ = try await model.api.createDict(kind, name: name)
                try await model.loadDictionaries()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func delete(at offsets: IndexSet) {
        let ids = offsets.map { model.entries(kind)[$0].id }
        Task {
            do {
                for id in ids { try await model.api.deleteDict(kind, id: id) }
                try await model.loadDictionaries()
                model.didChange()
            } catch {
                self.error = error.localizedDescription
                try? await model.loadDictionaries()
            }
        }
    }
}
