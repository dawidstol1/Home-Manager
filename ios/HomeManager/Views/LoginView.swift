import SwiftUI

/// Logowanie domownika albo – przy pierwszym uruchomieniu serwera – założenie konta administratora.
struct LoginView: View {
    @Environment(AppModel.self) private var model

    @State private var name = ""
    @State private var login = ""
    @State private var password = ""
    @State private var password2 = ""
    @State private var working = false
    @State private var error: String?

    private var isSetup: Bool { model.authState == .needsSetup }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 8) {
                        Text("🏠").font(.system(size: 48))
                        Text(isSetup ? "Utwórz konto administratora" : "Zaloguj się")
                            .font(.title2.bold())
                        Text(isSetup
                             ? "To pierwsze uruchomienie serwera. Domowników dodasz potem w aplikacji webowej (Więcej → Domownicy)."
                             : model.serverAddress)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }

                Section {
                    if isSetup {
                        TextField("Imię", text: $name)
                            .textContentType(.givenName)
                    }
                    TextField("Login", text: $login)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Hasło", text: $password)
                        .textContentType(isSetup ? .newPassword : .password)
                    if isSetup {
                        SecureField("Powtórz hasło", text: $password2)
                            .textContentType(.newPassword)
                    }
                }

                Section {
                    Button(action: submit) {
                        HStack {
                            Spacer()
                            if working { ProgressView() } else { Text(isSetup ? "Utwórz konto" : "Zaloguj").bold() }
                            Spacer()
                        }
                    }
                    .disabled(working || login.isEmpty || password.isEmpty || (isSetup && name.isEmpty))
                }
            }
            .navigationTitle("Home-Manager")
            .navigationBarTitleDisplayMode(.inline)
            .errorAlert($error)
        }
    }

    private func submit() {
        if isSetup && password != password2 {
            error = "Hasła się różnią"
            return
        }
        working = true
        Task {
            defer { working = false }
            do {
                if isSetup {
                    try await model.setupAdmin(name: name, login: login, password: password)
                } else {
                    try await model.login(login: login, password: password)
                }
                password = ""
                password2 = ""
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
