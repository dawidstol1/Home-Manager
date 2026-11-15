import Foundation

enum DateFormats {
    /// Format dat ważności używany przez API: `RRRR-MM-DD` (czas lokalny).
    static let day: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Znaczniki czasu SQLite (`datetime('now')`) – zawsze w UTC.
    static let sqlUTC: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()
}

extension Double {
    /// Liczba bez zbędnych zer, np. 2 → "2", 0.5 → "0,5".
    var amount: String {
        formatted(.number.precision(.fractionLength(0...3)).locale(Locale(identifier: "pl_PL")))
    }

    var pln: String {
        formatted(.currency(code: "PLN").locale(Locale(identifier: "pl_PL")))
    }
}

extension Item {
    var quantityText: String { "\(quantity.amount) \(unit)" }

    var expiryText: String? {
        guard let s = expiresAt, let d = DateFormats.day.date(from: s) else { return nil }
        return d.formatted(.dateTime.day().month(.twoDigits).year().locale(Locale(identifier: "pl_PL")))
    }

    var expiryBadge: String? {
        guard let days = daysToExpiry else { return nil }
        if days < 0 { return "po terminie" }
        if days == 0 { return "dziś" }
        if days <= 7 { return "za \(days) d." }
        return nil
    }
}
