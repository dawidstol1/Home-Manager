import Foundation

/// Zasób domowy – odpowiada obiektowi zwracanemu przez `/api/items`.
struct Item: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var categoryId: Int?
    var locationId: Int?
    var category: String?
    var location: String?
    var quantity: Double
    var unit: String
    var minQuantity: Double
    var price: Double?
    var expiresAt: String?
    var notes: String
    var barcode: String?
    /// Nazwa pliku zdjęcia na serwerze (`/images/<plik>`), pobranego z Open Food Facts.
    var image: String?
    var createdAt: String?
    var updatedAt: String?

    var isLow: Bool { minQuantity > 0 && quantity <= minQuantity }

    /// Liczba dni do końca ważności (ujemna = po terminie).
    var daysToExpiry: Int? {
        guard let date = expiresAt.flatMap(DateFormats.day.date(from:)) else { return nil }
        let today = Calendar.current.startOfDay(for: .now)
        return Calendar.current.dateComponents([.day], from: today, to: date).day
    }

    var isExpired: Bool { (daysToExpiry ?? 1) < 0 }
    var isExpiringSoon: Bool { daysToExpiry.map { $0 >= 0 && $0 <= 7 } ?? false }
}

/// Pozycja listy zakupów (`/api/shopping-list`) – zasób z wyliczoną ilością do kupienia.
struct ShoppingItem: Decodable, Identifiable, Hashable {
    let item: Item
    let toBuy: Double
    var id: Int { item.id }

    private enum CodingKeys: String, CodingKey { case toBuy }

    init(from decoder: Decoder) throws {
        item = try Item(from: decoder)
        toBuy = try decoder.container(keyedBy: CodingKeys.self).decode(Double.self, forKey: .toBuy)
    }
}

/// Dane wysyłane przy tworzeniu/edycji zasobu.
/// Pola opcjonalne są jawnie kodowane jako `null`, aby dało się je wyczyścić.
struct ItemInput: Encodable {
    var name: String = ""
    var categoryId: Int?
    var locationId: Int?
    var quantity: Double = 1
    var unit: String = "szt."
    var minQuantity: Double = 0
    var price: Double?
    var expiresAt: String?
    var notes: String = ""
    var barcode: String?

    init() {}

    init(from item: Item) {
        name = item.name
        categoryId = item.categoryId
        locationId = item.locationId
        quantity = item.quantity
        unit = item.unit
        minQuantity = item.minQuantity
        price = item.price
        expiresAt = item.expiresAt
        notes = item.notes
        barcode = item.barcode
    }

    private enum CodingKeys: String, CodingKey {
        case name, categoryId, locationId, quantity, unit, minQuantity, price, expiresAt, notes, barcode
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(categoryId, forKey: .categoryId)
        try c.encode(locationId, forKey: .locationId)
        try c.encode(quantity, forKey: .quantity)
        try c.encode(unit, forKey: .unit)
        try c.encode(minQuantity, forKey: .minQuantity)
        try c.encode(price, forKey: .price)
        try c.encode(expiresAt, forKey: .expiresAt)
        try c.encode(notes, forKey: .notes)
        try c.encode(barcode, forKey: .barcode)
    }
}

// MARK: - Skanowanie

/// Podpowiedź z bazy produktów (Open Food Facts) dla nieznanego kodu.
struct ProductHint: Decodable, Hashable {
    let barcode: String
    let name: String
    let brand: String?
    let quantity: String?
    let categoryHint: String?
}

/// Odpowiedź `/api/barcode/:code`.
struct BarcodeLookup: Decodable {
    let barcode: String
    let items: [Item]
    let product: ProductHint?
}

/// Odpowiedź `POST /api/items/:id/image`.
struct ImageFetchResult: Decodable {
    let item: Item
    let found: Bool
}

/// Odpowiedź `/api/expiry/parse`.
struct ExpiryParseResult: Decodable {
    let date: String?
}

/// Kategoria lub lokalizacja.
struct DictEntry: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var itemCount: Int?
}

enum DictKind: String, CaseIterable, Identifiable {
    case categories, locations
    var id: String { rawValue }
    var title: String { self == .categories ? "Kategorie" : "Lokalizacje" }
    var singular: String { self == .categories ? "kategoria" : "lokalizacja" }
}

struct HistoryEntry: Decodable, Identifiable, Hashable {
    let id: Int
    let delta: Double
    let note: String
    let createdAt: String

    var date: Date? { DateFormats.sqlUTC.date(from: createdAt) }
}

struct Stats: Decodable {
    struct CategoryCount: Decodable, Hashable {
        let name: String
        let count: Int
    }
    let totalItems: Int
    let totalValue: Double
    let lowStock: Int
    let expired: Int
    let expiringSoon: Int
    let byCategory: [CategoryCount]
}

enum StatusFilter: String, CaseIterable, Identifiable {
    case all = "", low, expiring, expired
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "Każdy status"
        case .low: "Niski stan"
        case .expiring: "Wkrótce traci ważność"
        case .expired: "Przeterminowane"
        }
    }
}

struct ItemFilter: Equatable {
    var query = ""
    var categoryId: Int?
    var locationId: Int?
    var status: StatusFilter = .all
}
