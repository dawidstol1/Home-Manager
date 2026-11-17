import Foundation
import Security

/// Zalogowany domownik (`/api/auth/me`, `/api/auth/login`).
struct UserAccount: Codable, Hashable {
    let id: Int
    let name: String
    let login: String
    let role: String

    var isAdmin: Bool { role == "admin" }
}

/// Odpowiedź `/api/auth/status`.
struct AuthStatus: Decodable {
    let setupRequired: Bool
    let user: UserAccount?
}

/// Odpowiedź logowania / zakładania pierwszego konta.
struct LoginResult: Decodable {
    let user: UserAccount
    let token: String
}

/// Token sesji przechowywany w pęku kluczy (Keychain), osobno dla każdego adresu serwera.
enum TokenStore {
    private static let service = "HomeManager.session"

    static func load(for server: String) -> String? {
        var query = baseQuery(server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String, for server: String) {
        delete(for: server)
        var query = baseQuery(server)
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    static func delete(for server: String) {
        SecItemDelete(baseQuery(server) as CFDictionary)
    }

    private static func baseQuery(_ server: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: server,
        ]
    }
}
