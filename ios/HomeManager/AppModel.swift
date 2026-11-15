import Foundation
import Observation

/// Wspólny stan aplikacji: konfiguracja serwera i słowniki.
@MainActor
@Observable
final class AppModel {
    private static let serverKey = "serverAddress"

    private(set) var serverAddress: String

    var categories: [DictEntry] = []
    var locations: [DictEntry] = []

    /// Zwiększany po każdej zmianie danych – widoki odświeżają się przez `.task(id:)`.
    private(set) var revision = 0

    init() {
        serverAddress = UserDefaults.standard.string(forKey: Self.serverKey) ?? ""
    }

    func setServerAddress(_ address: String) {
        serverAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(serverAddress, forKey: Self.serverKey)
        categories = []
        locations = []
        didChange()
    }

    var isConfigured: Bool { APIClient(serverAddress: serverAddress) != nil }

    var api: APIClient {
        get throws {
            guard let client = APIClient(serverAddress: serverAddress) else { throw APIError.invalidServerURL }
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
