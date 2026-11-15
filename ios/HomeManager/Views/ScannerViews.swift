import AVFoundation
import SwiftUI
import UIKit
import Vision
import VisionKit

// MARK: - Most do VisionKit

/// Podgląd z aparatu z rozpoznawaniem kodów lub tekstu na żywo (VisionKit, iOS 16+, iPhone XS i nowsze).
struct DataScannerView: UIViewControllerRepresentable {
    let recognizedDataTypes: Set<DataScannerViewController.RecognizedDataType>
    var recognizesMultipleItems = false
    let onUpdate: ([RecognizedItem]) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: recognizedDataTypes,
            qualityLevel: .balanced,
            recognizesMultipleItems: recognizesMultipleItems,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        context.coordinator.onUpdate = onUpdate
        if !controller.isScanning {
            try? controller.startScanning()
        }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onUpdate: onUpdate) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onUpdate: ([RecognizedItem]) -> Void

        init(onUpdate: @escaping ([RecognizedItem]) -> Void) {
            self.onUpdate = onUpdate
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            onUpdate(allItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            onUpdate(allItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didRemove removedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            onUpdate(allItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            onUpdate([item])
        }
    }
}

// MARK: - Dostęp do aparatu

enum CameraAvailability: Equatable {
    case checking, ready, denied, unsupported
}

@MainActor
func checkCameraForScanning() async -> CameraAvailability {
    guard DataScannerViewController.isSupported else { return .unsupported }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        break
    case .notDetermined:
        guard await AVCaptureDevice.requestAccess(for: .video) else { return .denied }
    default:
        return .denied
    }
    return DataScannerViewController.isAvailable ? .ready : .denied
}

private struct CameraUnavailableView: View {
    let availability: CameraAvailability

    var body: some View {
        switch availability {
        case .checking:
            ProgressView()
        case .denied:
            ContentUnavailableView {
                Label("Brak dostępu do aparatu", systemImage: "camera.fill")
            } description: {
                Text("Zezwól na dostęp w Ustawieniach iOS lub wpisz kod ręcznie.")
            } actions: {
                Button("Otwórz Ustawienia") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        case .unsupported, .ready:
            ContentUnavailableView(
                "Skanowanie niedostępne",
                systemImage: "camera.metering.unknown",
                description: Text("To urządzenie (lub symulator) nie obsługuje skanowania na żywo. Wpisz dane ręcznie.")
            )
        }
    }
}

// MARK: - Kod kreskowy

/// Arkusz skanowania kodu kreskowego. Wywołuje `onCode` raz, z pierwszym odczytanym kodem.
struct BarcodeScannerSheet: View {
    let onCode: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var availability: CameraAvailability = .checking
    @State private var manualCode = ""
    @State private var handled = false

    private static let symbologies: [VNBarcodeSymbology] = [.ean13, .ean8, .upce, .code128, .code39, .qr]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    if availability == .ready {
                        DataScannerView(recognizedDataTypes: [.barcode(symbologies: Self.symbologies)]) { items in
                            for case let .barcode(barcode) in items {
                                if let code = barcode.payloadStringValue, !code.isEmpty {
                                    deliver(code)
                                    return
                                }
                            }
                        }
                        .ignoresSafeArea(edges: .horizontal)
                        Text("Skieruj aparat na kod kreskowy")
                            .font(.callout.weight(.medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                            .frame(maxHeight: .infinity, alignment: .top)
                            .padding(.top, 16)
                    } else {
                        CameraUnavailableView(availability: availability)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                HStack {
                    TextField("…lub wpisz kod ręcznie", text: $manualCode)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(submitManual)
                    Button("OK", action: submitManual)
                        .buttonStyle(.borderedProminent)
                        .disabled(manualCode.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding()
                .background(.bar)
            }
            .navigationTitle("Skanuj kod")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
            }
            .task { availability = await checkCameraForScanning() }
        }
    }

    private func submitManual() {
        let code = manualCode.trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { return }
        deliver(code)
    }

    private func deliver(_ code: String) {
        guard !handled else { return }
        handled = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode(code)
        dismiss()
    }
}

// MARK: - Data ważności

/// Arkusz odczytu daty ważności z etykiety (rozpoznawanie tekstu na żywo + parser na serwerze).
struct ExpiryScannerSheet: View {
    /// Zamienia rozpoznany tekst na datę `RRRR-MM-DD` (lub `nil`).
    let parse: @MainActor (String) async -> String?
    let onDate: (Date) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var availability: CameraAvailability = .checking
    @State private var lastText = ""
    @State private var parseTask: Task<Void, Never>?
    @State private var detected: Date?
    @State private var manualDate = Date.now

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    if availability == .ready {
                        DataScannerView(recognizedDataTypes: [.text()], recognizesMultipleItems: true) { items in
                            let text = items.compactMap { item -> String? in
                                if case let .text(recognized) = item { return recognized.transcript }
                                return nil
                            }.joined(separator: "\n")
                            schedule(text)
                        }
                        .ignoresSafeArea(edges: .horizontal)
                        Text("Skieruj aparat na datę ważności")
                            .font(.callout.weight(.medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                            .frame(maxHeight: .infinity, alignment: .top)
                            .padding(.top, 16)
                    } else {
                        CameraUnavailableView(availability: availability)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(spacing: 12) {
                    if let detected {
                        HStack {
                            Label {
                                Text(detected.formatted(date: .long, time: .omitted))
                                    .fontWeight(.semibold)
                            } icon: {
                                Image(systemName: "calendar.badge.checkmark").foregroundStyle(.green)
                            }
                            Spacer()
                            Button("Użyj") { finish(detected) }
                                .buttonStyle(.borderedProminent)
                        }
                    } else if availability == .ready {
                        Label("Szukam daty na etykiecie…", systemImage: "text.viewfinder")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack {
                        DatePicker("Ręcznie", selection: $manualDate, displayedComponents: .date)
                            .environment(\.locale, Locale(identifier: "pl_PL"))
                        Button("Ustaw") { finish(manualDate) }
                            .buttonStyle(.bordered)
                    }
                }
                .padding()
                .background(.bar)
            }
            .navigationTitle("Data ważności")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
            }
            .task { availability = await checkCameraForScanning() }
            .onDisappear { parseTask?.cancel() }
        }
    }

    /// Odczekuje chwilę, aż tekst się ustabilizuje, i dopiero wtedy pyta serwer.
    private func schedule(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != lastText else { return }
        lastText = trimmed
        parseTask?.cancel()
        parseTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            if let value = await parse(trimmed), let date = DateFormats.day.date(from: value) {
                guard !Task.isCancelled else { return }
                if detected != date {
                    UISelectionFeedbackGenerator().selectionChanged()
                }
                detected = date
            }
        }
    }

    private func finish(_ date: Date) {
        parseTask?.cancel()
        onDate(date)
        dismiss()
    }
}
