import Foundation

enum APIError: LocalizedError {
    case invalidServerURL
    case server(status: Int, message: String)
    case transport(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            "Nieprawidłowy adres serwera. Ustaw go w zakładce Ustawienia."
        case let .server(_, message):
            message
        case let .transport(err):
            "Brak połączenia z serwerem: \(err.localizedDescription)"
        case let .decoding(err):
            "Nieoczekiwana odpowiedź serwera: \(err.localizedDescription)"
        }
    }
}

/// Klient REST API serwera Home-Manager.
struct APIClient {
    var baseURL: URL
    var session: URLSession = .shared
    /// Token sesji (nagłówek `Authorization: Bearer`). Bez niego serwer odpowiada 401.
    var token: String?

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    /// Tworzy klienta z adresu wpisanego przez użytkownika, np. `192.168.1.10:3000`.
    init?(serverAddress: String) {
        var text = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host() != nil else { return nil }
        baseURL = url
    }

    // MARK: - Zasoby

    func items(filter: ItemFilter = .init()) async throws -> [Item] {
        var query: [URLQueryItem] = []
        if !filter.query.isEmpty { query.append(.init(name: "q", value: filter.query)) }
        if let c = filter.categoryId { query.append(.init(name: "category_id", value: String(c))) }
        if let l = filter.locationId { query.append(.init(name: "location_id", value: String(l))) }
        if filter.status != .all { query.append(.init(name: "status", value: filter.status.rawValue)) }
        return try await get("items", query: query)
    }

    func item(_ id: Int) async throws -> Item { try await get("items/\(id)") }

    func createItem(_ input: ItemInput) async throws -> Item {
        try await send("POST", "items", body: input)
    }

    func updateItem(_ id: Int, _ input: ItemInput) async throws -> Item {
        try await send("PUT", "items/\(id)", body: input)
    }

    func deleteItem(_ id: Int) async throws {
        try await sendNoContent("DELETE", "items/\(id)")
    }

    /// `reason`: `used` / `wasted` (zużycie) albo `purchase` (dokupienie); nil = domyślny powód serwera.
    func adjust(_ id: Int, delta: Double, note: String = "", reason: String? = nil) async throws -> Item {
        struct Body: Encodable { let delta: Double; let note: String; let reason: String? }
        return try await send("POST", "items/\(id)/adjust", body: Body(delta: delta, note: note, reason: reason))
    }

    /// Zdejmuje całą partię (`used` – zużyta, `wasted` – wyrzucona).
    func removeBatch(_ batchId: Int, reason: String) async throws -> Item {
        var req = URLRequest(url: url("batches/\(batchId)", query: [URLQueryItem(name: "reason", value: reason)]))
        req.httpMethod = "DELETE"
        return try await perform(req)
    }

    /// Szybkie zużycie po zeskanowaniu kodu: −1 z partii o najkrótszym terminie.
    func consume(barcode: String, reason: String = "used") async throws -> ConsumeResult {
        struct Body: Encodable { let barcode: String; let reason: String }
        return try await send("POST", "consume", body: Body(barcode: barcode, reason: reason))
    }

    // MARK: - Konto

    func authStatus() async throws -> AuthStatus { try await get("auth/status") }

    func login(login: String, password: String) async throws -> LoginResult {
        struct Body: Encodable { let login: String; let password: String }
        return try await send("POST", "auth/login", body: Body(login: login, password: password))
    }

    /// Pierwsze uruchomienie serwera: zakłada konto administratora.
    func setup(name: String, login: String, password: String) async throws -> LoginResult {
        struct Body: Encodable { let name: String; let login: String; let password: String }
        return try await send("POST", "auth/setup", body: Body(name: name, login: login, password: password))
    }

    func logout() async throws {
        struct Empty: Encodable {}
        struct Ok: Decodable {}
        let _: Ok = try await send("POST", "auth/logout", body: Empty())
    }

    func history(_ id: Int) async throws -> [HistoryEntry] { try await get("items/\(id)/history") }

    // MARK: - Zdjęcia

    /// Adres zdjęcia produktu zapisanego na serwerze.
    func imageURL(_ file: String) -> URL {
        baseURL.appending(path: "images").appending(path: file)
    }

    /// Szuka zdjęcia w Open Food Facts po kodzie kreskowym i zapisuje je na serwerze.
    func fetchImage(_ id: Int) async throws -> ImageFetchResult {
        struct Empty: Encodable {}
        return try await send("POST", "items/\(id)/image", body: Empty())
    }

    func removeImage(_ id: Int) async throws -> Item {
        var req = URLRequest(url: url("items/\(id)/image"))
        req.httpMethod = "DELETE"
        return try await perform(req)
    }

    // MARK: - Skanowanie

    func lookupBarcode(_ code: String) async throws -> BarcodeLookup {
        try await get("barcode", query: [URLQueryItem(name: "code", value: code)])
    }

    /// Odczytuje datę ważności z tekstu rozpoznanego na etykiecie (parser po stronie serwera).
    func parseExpiry(_ text: String) async throws -> String? {
        struct Body: Encodable { let text: String }
        let result: ExpiryParseResult = try await send("POST", "expiry/parse", body: Body(text: text))
        return result.date
    }

    // MARK: - Raporty

    func stats() async throws -> Stats { try await get("stats") }
    func shoppingList() async throws -> [ShoppingItem] { try await get("shopping-list") }

    // MARK: - Słowniki

    func dict(_ kind: DictKind) async throws -> [DictEntry] { try await get(kind.rawValue) }

    func createDict(_ kind: DictKind, name: String) async throws -> DictEntry {
        struct Body: Encodable { let name: String }
        return try await send("POST", kind.rawValue, body: Body(name: name))
    }

    func deleteDict(_ kind: DictKind, id: Int) async throws {
        try await sendNoContent("DELETE", "\(kind.rawValue)/\(id)")
    }

    // MARK: - Warstwa HTTP

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var url = baseURL.appending(path: "api/" + path)
        if !query.isEmpty { url.append(queryItems: query) }
        return url
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(URLRequest(url: url(path, query: query)))
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: some Encodable) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        return try await perform(req)
    }

    private func sendNoContent(_ method: String, _ path: String) async throws {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        _ = try await fetch(req)
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data = try await fetch(request)
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    private func fetch(_ request: URLRequest) async throws -> Data {
        var request = request
        request.timeoutInterval = 10
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct ErrorBody: Decodable { let error: String }
            let message = (try? Self.decoder.decode(ErrorBody.self, from: data))?.error ?? "Błąd serwera (\(status))"
            if status == 401 {
                await MainActor.run { NotificationCenter.default.post(name: .sessionExpired, object: nil) }
            }
            throw APIError.server(status: status, message: message)
        }
        return data
    }
}

extension Notification.Name {
    /// Serwer odrzucił token (wylogowanie, zmiana hasła) – aplikacja pokazuje ekran logowania.
    static let sessionExpired = Notification.Name("HomeManager.sessionExpired")
}
