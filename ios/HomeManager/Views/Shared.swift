import SwiftUI

// MARK: - Obsługa błędów

extension View {
    /// Pokazuje alert, gdy `message` nie jest `nil`.
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert(
            "Błąd",
            isPresented: Binding(
                get: { message.wrappedValue != nil },
                set: { if !$0 { message.wrappedValue = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}

/// Anulowanie zadania (np. przy ponownym odświeżeniu) nie jest błędem dla użytkownika.
func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if case let APIError.transport(inner) = error, (inner as? URLError)?.code == .cancelled { return true }
    return (error as? URLError)?.code == .cancelled
}

// MARK: - Liczby wpisywane przez użytkownika

/// Akceptuje zarówno przecinek, jak i kropkę dziesiętną.
func parseDecimal(_ text: String) -> Double? {
    let normalized = text
        .trimmingCharacters(in: .whitespaces)
        .replacingOccurrences(of: " ", with: "")
        .replacingOccurrences(of: ",", with: ".")
    guard !normalized.isEmpty, let value = Double(normalized), value.isFinite else { return nil }
    return value
}

// MARK: - Wspólne elementy UI

struct Badge: View {
    enum Style { case warning, danger }
    let text: String
    let style: Style

    var body: some View {
        let color: Color = style == .danger ? .red : .orange
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.15), in: Capsule())
    }
}

struct NotConfiguredView: View {
    var body: some View {
        ContentUnavailableView(
            "Brak połączenia z serwerem",
            systemImage: "server.rack",
            description: Text("Podaj adres serwera Home-Manager w zakładce Ustawienia.")
        )
    }
}

/// Wiersz zasobu używany na listach.
struct ItemRow: View {
    let item: Item

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name).font(.body.weight(.semibold))
                let meta = [item.category, item.location].compactMap { $0 }.joined(separator: " · ")
                if !meta.isEmpty {
                    Text(meta).font(.caption).foregroundStyle(.secondary)
                }
                if !item.notes.isEmpty {
                    Text(item.notes).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                Text(item.quantityText)
                    .monospacedDigit()
                    .foregroundStyle(item.isLow ? Color.orange : Color.primary)
                if item.isLow {
                    Badge(text: "mało", style: .warning)
                }
                if let badge = item.expiryBadge {
                    Badge(text: badge, style: item.isExpired ? .danger : .warning)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
