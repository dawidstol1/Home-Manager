import Foundation
import Observation

/// Wspólny stan aplikacji: konfiguracja serwera i słowniki.
@MainActor
@Observable
final class AppModel {
    private static let serverKey = "serverAddress"

    private(set) var serverAddress: String

    /// Stan logowania na wybranym serwerze.
    enum AuthState: Equatable { case unknown, needsLogin, needsSetup, loggedIn }
    private(set) var authState: AuthState = .unknown
    private(set) var user: UserAccount?
    private var token: String?

    var categories: [DictEntry] = []
    var locations: [DictEntry] = []

    /// Zwiększany po każdej zmianie danych – widoki odświeżają się przez `.task(id:)`.
    private(set) var revision = 0

    init() {
        serverAddress = UserDefaults.standard.string(forKey: Self.serverKey) ?? ""
        token = TokenStore.load(for: serverAddress)
        NotificationCenter.default.addObserver(forName: .sessionExpired, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sessionExpired() }
        }
    }

    func setServerAddress(_ address: String) {
        serverAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(serverAddress, forKey: Self.serverKey)
        token = TokenStore.load(for: serverAddress)
        user = nil
        authState = .unknown
        categories = []
        locations = []
        didChange()
    }

    // MARK: - Logowanie

    /// Sprawdza na serwerze, czy token jest ważny i czy trzeba założyć pierwsze konto.
    func checkAuth() async {
        guard let client = try? api else { return }
        do {
            let status = try await client.authStatus()
            if let u = status.user {
                user = u
                authState = .loggedIn
            } else {
                user = nil
                authState = status.setupRequired ? .needsSetup : .needsLogin
            }
        } catch {
            // Brak połączenia – zostaw poprzedni stan; widoki pokażą błąd sieci.
            if authState == .unknown && token == nil { authState = .needsLogin }
        }
    }

    func login(login: String, password: String) async throws {
        let result = try await api.login(login: login, password: password)
        signedIn(result)
    }

    func setupAdmin(name: String, login: String, password: String) async throws {
        let result = try await api.setup(name: name, login: login, password: password)
        signedIn(result)
    }

    func logout() async {
        try? await api.logout()
        TokenStore.delete(for: serverAddress)
        token = nil
        user = nil
        authState = .needsLogin
    }

    private func signedIn(_ result: LoginResult) {
        token = result.token
        TokenStore.save(result.token, for: serverAddress)
        user = result.user
        authState = .loggedIn
        didChange()
    }

    private func sessionExpired() {
        guard authState == .loggedIn else { return }
        TokenStore.delete(for: serverAddress)
        token = nil
        user = nil
        authState = .needsLogin
    }

    var isConfigured: Bool { APIClient(serverAddress: serverAddress) != nil }

    var api: APIClient {
        get throws {
            guard var client = APIClient(serverAddress: serverAddress) else { throw APIError.invalidServerURL }
            client.token = token
            return client
        }
    }

    func entries(_ kind: DictKind) -> [DictEntry] {
        kind == .categories ? categories : locations
    }

    func loadDictionaries() async throws {
        let client = try api
        async let cats = client.dict(.categories)
        async let locs = client.dict(.locations)
        (categories, locations) = try await (cats, locs)
    }

    /// Sygnalizuje zmianę danych wszystkim widokom.
    func didChange() {
        revision += 1
    }
}
