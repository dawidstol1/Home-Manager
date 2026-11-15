# 🏠 Home-Manager — Manager zasobów domowych

Prosta aplikacja webowa do ewidencji zapasów i rzeczy w domu: co mamy, gdzie leży,
ile zostało, kiedy traci ważność i co trzeba dokupić.

## Funkcje

- **Zasoby** – nazwa, kategoria, lokalizacja, ilość i jednostka, stan minimalny, cena, data ważności, notatki
- **Szybka zmiana stanu** (+ / −) z **historią zmian** dla każdej pozycji
- **Pulpit** – liczba zasobów, wartość zapasów, kończące się produkty, terminy ważności, podział na kategorie
- **Lista zakupów** generowana automatycznie z pozycji poniżej stanu minimalnego (przycisk „Kupione ✓” uzupełnia stan)
- **Wyszukiwanie i filtry** – po nazwie/notatkach, kategorii, lokalizacji i statusie (niski stan, wkrótce traci ważność, przeterminowane)
- **Kategorie i lokalizacje** – edytowalne słowniki (z domyślnym zestawem na start)
- **Kopia zapasowa** – eksport/import wszystkich danych do pliku JSON
- Responsywny interfejs, tryb ciemny zgodny z ustawieniami systemu
- **iOS:** natywna aplikacja SwiftUI (`ios/`) oraz PWA do zainstalowania z Safari

## Wymagania

- Node.js **22.13+** (korzysta z wbudowanego modułu `node:sqlite`)
- Brak zewnętrznych zależności – nie trzeba uruchamiać `npm install`

## Uruchomienie

```bash
npm start          # http://127.0.0.1:3000
npm run dev        # tryb z automatycznym przeładowaniem
npm test           # testy API
```

Zmienne środowiskowe:

| Zmienna   | Domyślnie                   | Opis                       |
|-----------|-----------------------------|----------------------------|
| `PORT`    | `3000`                      | Port serwera               |
| `HOST`    | `127.0.0.1`                 | Adres nasłuchu (`0.0.0.0`, by udostępnić w sieci domowej) |
| `DB_FILE` | `data/home-manager.db`      | Ścieżka do pliku bazy SQLite |

## iOS

### Aplikacja natywna (SwiftUI)

Klient REST API tego serwera – dane są wspólne z wersją webową, więc cała rodzina widzi te same zapasy.

Wymagania: Mac z **Xcode 16+**, iOS **17+**.

1. Uruchom serwer tak, by był dostępny w sieci domowej:
   ```bash
   HOST=0.0.0.0 npm start
   ```
2. Otwórz `ios/HomeManager.xcodeproj` w Xcode.
3. W ustawieniach targetu *HomeManager → Signing & Capabilities* wybierz swój zespół (wystarczy darmowe Apple ID)
   i w razie potrzeby zmień *Bundle Identifier*.
4. Uruchom na symulatorze lub iPhonie (⌘R).
5. W aplikacji przejdź do **Ustawienia** i wpisz adres serwera, np. `192.168.1.10:3000` lub `moj-mac.local:3000`.
   Przy pierwszym połączeniu iOS zapyta o dostęp do sieci lokalnej – zezwól.

Funkcje: pulpit ze statystykami, lista zasobów z wyszukiwaniem i filtrami, gesty przesunięcia (+1 / −1 / usuń),
szczegóły z historią zmian, formularz dodawania/edycji, lista zakupów z udostępnianiem, zarządzanie kategoriami
i lokalizacjami.

Połączenia HTTP są dozwolone tylko w sieci lokalnej (`NSAllowsLocalNetworking` w `ios/Info.plist`).
Aby korzystać z aplikacji poza domem, wystaw serwer przez HTTPS (np. reverse proxy) lub VPN.

```
ios/
  HomeManager.xcodeproj
  Info.plist                 – wyjątek ATS dla sieci lokalnej
  HomeManager/
    HomeManagerApp.swift     – punkt wejścia
    Models.swift             – modele danych API
    APIClient.swift          – klient REST (async/await)
    AppModel.swift           – wspólny stan (adres serwera, słowniki)
    Formatting.swift         – formatowanie liczb i dat (pl_PL)
    Views/                   – ekrany SwiftUI
    Assets.xcassets          – ikona i kolor akcentu
```

### PWA (bez Xcode)

Wersja webowa działa też jako aplikacja na ekranie głównym: otwórz adres serwera w Safari na iPhonie →
**Udostępnij → Do ekranu początkowego**. Uruchamia się na pełnym ekranie, z własną ikoną.

Tryb offline (service worker – podgląd ostatnio pobranych danych) wymaga HTTPS lub `localhost`;
przez zwykłe HTTP w sieci lokalnej aplikacja działa, ale tylko online.

## Struktura projektu

```
src/
  db.js       – schemat bazy, walidacja i logika (klasa Store)
  app.js      – routing REST API i serwowanie plików statycznych
  server.js   – punkt startowy serwera HTTP
public/       – interfejs (HTML, CSS, JS bez frameworków) + manifest PWA i service worker
ios/          – natywna aplikacja iOS (SwiftUI)
test/         – testy API (node:test)
data/         – plik bazy danych (ignorowany przez git)
```

## REST API

| Metoda | Ścieżka | Opis |
|--------|---------|------|
| GET | `/api/items?q=&category_id=&location_id=&status=low\|expiring\|expired` | Lista zasobów |
| POST | `/api/items` | Dodanie zasobu |
| GET / PUT / PATCH / DELETE | `/api/items/:id` | Odczyt / edycja / usunięcie |
| POST | `/api/items/:id/adjust` | Zmiana stanu `{ "delta": -1, "note": "..." }` |
| GET | `/api/items/:id/history` | Historia zmian stanu |
| GET / POST | `/api/categories`, `/api/locations` | Słowniki |
| DELETE | `/api/categories/:id`, `/api/locations/:id` | Usunięcie pozycji słownika |
| GET | `/api/stats` | Statystyki pulpitu |
| GET | `/api/shopping-list` | Lista zakupów |
| GET / POST | `/api/export`, `/api/import` | Kopia zapasowa JSON |

Przykład:

```bash
curl -X POST localhost:3000/api/items -H 'Content-Type: application/json' \
  -d '{"name":"Mąka","quantity":2,"unit":"kg","min_quantity":1}'
```
