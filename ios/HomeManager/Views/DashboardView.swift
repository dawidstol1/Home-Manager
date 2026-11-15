import SwiftUI

struct DashboardView: View {
    @Environment(AppModel.self) private var model

    @State private var stats: Stats?
    @State private var low: [Item] = []
    @State private var expiring: [Item] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if !model.isConfigured {
                    NotConfiguredView()
                } else if let stats {
                    content(stats)
                } else {
                    ProgressView("Wczytywanie…")
                }
            }
            .navigationTitle("Pulpit")
            .navigationDestination(for: Int.self) { ItemDetailView(itemId: $0) }
            .task(id: model.revision) { await load() }
            .refreshable { await load() }
            .errorAlert($error)
        }
    }

    private func content(_ stats: Stats) -> some View {
        List {
            Section {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12)], spacing: 12) {
                    StatTile(title: "Wszystkie zasoby", value: "\(stats.totalItems)", systemImage: "shippingbox")
                    StatTile(title: "Wartość zapasów", value: stats.totalValue.pln, systemImage: "banknote")
                    StatTile(title: "Niski stan", value: "\(stats.lowStock)", systemImage: "exclamationmark.triangle",
                             tint: stats.lowStock > 0 ? .orange : nil)
                    StatTile(title: "Wkrótce tracą ważność", value: "\(stats.expiringSoon)", systemImage: "clock",
                             tint: stats.expiringSoon > 0 ? .orange : nil)
                    StatTile(title: "Przeterminowane", value: "\(stats.expired)", systemImage: "xmark.octagon",
                             tint: stats.expired > 0 ? .red : nil)
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())

            Section("Kończące się zapasy") {
                if low.isEmpty {
                    Text("Wszystkie zapasy na odpowiednim poziomie 👍").foregroundStyle(.secondary)
                }
                ForEach(low) { item in
                    NavigationLink(value: item.id) {
                        LabeledContent(item.name) {
                            Text("\(item.quantity.amount) / min \(item.minQuantity.amount) \(item.unit)")
                                .foregroundStyle(.orange)
                                .monospacedDigit()
                        }
                    }
                }
            }

            Section("Termin ważności (≤ 7 dni)") {
                if expiring.isEmpty {
                    Text("Brak produktów z bliskim terminem").foregroundStyle(.secondary)
                }
                ForEach(expiring) { item in
                    NavigationLink(value: item.id) {
                        LabeledContent(item.name) {
                            HStack(spacing: 6) {
                                Text(item.expiryText ?? "")
                                if let badge = item.expiryBadge {
                                    Badge(text: badge, style: item.isExpired ? .danger : .warning)
                                }
                            }
                        }
                    }
                }
            }

            if !stats.byCategory.isEmpty {
                Section("Zasoby wg kategorii") {
                    let maxCount = Double(stats.byCategory.map(\.count).max() ?? 1)
                    ForEach(stats.byCategory, id: \.name) { cat in
                        VStack(alignment: .leading, spacing: 4) {
                            LabeledContent(cat.name, value: "\(cat.count)")
                            ProgressView(value: Double(cat.count), total: maxCount)
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        guard model.isConfigured else { return }
        do {
            let api = try model.api
            async let s = api.stats()
            async let l = api.items(filter: ItemFilter(status: .low))
            async let e = api.items(filter: ItemFilter(status: .expiring))
            let (newStats, newLow, newExpiring) = try await (s, l, e)
            stats = newStats
            low = newLow
            expiring = newExpiring.sorted { ($0.expiresAt ?? "") < ($1.expiresAt ?? "") }
        } catch let error where !isCancellation(error) {
            self.error = error.localizedDescription
        } catch {}
    }
}

private struct StatTile: View {
    let title: String
    let value: String
    let systemImage: String
    var tint: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: systemImage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2, reservesSpace: true)
            Text(value)
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(tint ?? Color.primary)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
