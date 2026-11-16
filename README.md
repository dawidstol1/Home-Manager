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
- **Skanowanie etykiet** – kod kreskowy (EAN/UPC/QR…) rozpoznaje znany produkt (szybkie +1/−1),
  a nowy podpowiada nazwę z bazy Open Food Facts; datę ważności można odczytać ze zdjęcia etykiety (OCR)
- **Zdjęcia produktów** pobierane automatycznie z Open Food Facts po kodzie kreskowym i zapisywane lokalnie
- **iOS:** natywna aplikacja SwiftUI (`ios/`) oraz PWA do zainstalowania z Safari

## Uruchomienie – najprościej (Docker)

Potrzebny jest tylko [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows / macOS) albo Docker na Linuksie.

```bash
docker compose up -d        # PostgreSQL + aplikacja → http://localhost:3000
docker compose logs -f app  # podgląd logów
docker compose down         # zatrzymanie (dane zostają w wolumenach)
```

Dane bazy PostgreSQL i zdjęcia produktów są trzymane w wolumenach Dockera (`pgdata`, `images`), więc przetrwają
restart i aktualizację. Hasło bazy można zmienić zmienną `POSTGRES_PASSWORD` (np. w pliku `.env` obok
`docker-compose.yml`) – **przed** pierwszym uruchomieniem.

## Uruchomienie bez Dockera

Wymagania: Node.js **22.13+** i PostgreSQL **13+** (testowane na 16).

```bash
# jednorazowo: użytkownik i baza w PostgreSQL
sudo -u postgres psql -c "CREATE ROLE homemanager LOGIN PASSWORD 'homemanager';"
sudo -u postgres psql -c "CREATE DATABASE homemanager OWNER homemanager;"

npm install
npm start          # http://127.0.0.1:3000 – tabele tworzą się same przy pierwszym starcie
npm run dev        # tryb z automatycznym przeładowaniem
```

Testy potrzebują osobnej bazy `homemanager_test` (każdy plik testów tworzy w niej i usuwa własny schemat):

```bash
sudo -u postgres psql -c "CREATE DATABASE homemanager_test OWNER homemanager;"
npm test
```

Zmienne środowiskowe:

| Zmienna   | Domyślnie                   | Opis                       |
|-----------|-----------------------------|----------------------------|
| `DATABASE_URL` | `postgres://homemanager:homemanager@localhost:5432/homemanager` | Połączenie z PostgreSQL |
| `TEST_DATABASE_URL` | `…/homemanager_test` | Baza dla `npm test` |
| `PORT`    | `3000`                      | Port serwera               |
| `HOST`    | `127.0.0.1`                 | Adres nasłuchu (`0.0.0.0`, by udostępnić w sieci domowej) |
| `PRODUCT_LOOKUP` | włączone             | `off` wyłącza podpowiedzi nazw i zdjęcia z Open Food Facts |
| `IMAGES_DIR` | `data/images`            | Katalog na pobrane zdjęcia produktów |

**Baza danych:** tabele `items` (produkty), `categories`, `locations`, `history` (każda zmiana stanu) i
`barcode_cache` (zapamiętane odpowiedzi Open Food Facts). Zmiany ilości są wykonywane w transakcji z blokadą
wiersza, więc kilka osób może jednocześnie zużywać i dokupować ten sam produkt bez gubienia zmian.
Kopia zapasowa: przycisk „Eksportuj JSON” w Ustawieniach albo `pg_dump homemanager > kopia.sql`.

## Interfejs

- **Kafelki ze zdjęciami** (domyślnie) albo **tabela** – przełącznik nad listą, wybór jest zapamiętywany.
- **Miejsca** – przyciski „Wszystkie / Kuchnia / Spiżarnia…” z liczbą produktów do szybkiego filtrowania.
- **Na telefonie** – dolny pasek nawigacji z licznikiem zakupów i pływający przycisk 📷 do skanowania.
- Usuwanie produktu jest też dostępne w formularzu edycji.

## Skanowanie etykiet

**Kod kreskowy** – przycisk „📷 Skanuj” (web) lub ikona kodu (iOS) na liście zasobów:

- kod przypisany już do zasobu → okno z tą pozycją i przyciskami −/+ (np. zużycie przy wyjmowaniu z szafki),
- nowy kod → formularz nowego zasobu z wpisanym kodem i, jeśli produkt jest w bazie
  [Open Food Facts](https://world.openfoodfacts.org), z podpowiedzianą nazwą i kategorią.

Kod można też zeskanować bezpośrednio w formularzu (pole „Kod kreskowy”).

**Zdjęcia produktów** – gdy dodajesz produkt z kodem kreskowym, serwer w tle szuka go w Open Food Facts,
pobiera zdjęcie opakowania i zapisuje je w `data/images/` (w Dockerze: wolumen `images`) (potem działa bez internetu). W formularzu produktu są
przyciski „Pobierz zdjęcie z internetu” i „Usuń zdjęcie”, a w Ustawieniach „Pobierz brakujące zdjęcia” dla produktów
dodanych wcześniej. Zdjęcia są dostępne głównie dla żywności i napojów; pozostałe produkty mają literę zamiast zdjęcia.

**Data ważności (OCR)** – w formularzu przycisk „📷 Z etykiety” (web) / „Odczytaj datę z etykiety” (iOS).
Rozpoznany tekst trafia do parsera na serwerze, który rozumie m.in. `12.05.2027`, `12/05/27`, `2027-05-12`,
`05.2027`, `EXP 05/27`, `12 MAJ 2027`, preferuje daty przy „Najlepiej spożyć przed / Należy spożyć do / EXP / BB”
i pomija daty przy „Data produkcji / LOT”. Odczytaną datę zawsze można poprawić przed zapisaniem.

| | Web / PWA | iOS (natywnie) |
|---|---|---|
| Kod kreskowy | kamera na żywo (HTTPS lub `localhost`), zdjęcie z aparatu (działa też przez HTTP), wpisanie ręczne | VisionKit na żywo + wpisanie ręczne |
| Data ważności | zdjęcie etykiety → Tesseract.js w przeglądarce | rozpoznawanie tekstu na żywo (VisionKit) |

Uwagi:

- Do Open Food Facts wysyłany jest **tylko numer kodu kreskowego** (i tylko dla kodów, których nie ma jeszcze
  w Twojej bazie); wyniki są zapamiętywane lokalnie. Wyłączenie: `PRODUCT_LOOKUP=off`.
- OCR w przeglądarce pobiera przy pierwszym użyciu ok. 5 MB (Tesseract.js z cdn.jsdelivr.net) – potem
  przeglądarka trzyma to w pamięci podręcznej. Rozpoznawanie odbywa się na urządzeniu, zdjęcie nigdzie nie jest wysyłane.
- Skanowanie na żywo w iOS wymaga iPhone'a XS lub nowszego; w symulatorze dostępne jest tylko wpisanie ręczne.

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
  db.js       – PostgreSQL: schemat, walidacja i logika (klasa Store)
  products.js – podpowiedzi produktów po kodzie (Open Food Facts + cache)
  images.js   – pobieranie i przechowywanie zdjęć produktów
  expiry.js   – odczyt daty ważności z tekstu etykiety
  app.js      – routing REST API i serwowanie plików statycznych
  server.js   – punkt startowy serwera HTTP
public/       – interfejs (HTML, CSS, JS bez frameworków) + manifest PWA i service worker
  scanner.js  – skanowanie kodów (BarcodeDetector / ZXing) i OCR dat (Tesseract.js)
  vendor/     – dołączona biblioteka ZXing (Apache-2.0)
ios/          – natywna aplikacja iOS (SwiftUI)
test/         – testy API (node:test)
data/         – zdjęcia produktów (ignorowane przez git)
Dockerfile, docker-compose.yml – uruchomienie z PostgreSQL jednym poleceniem
```

## REST API

| Metoda | Ścieżka | Opis |
|--------|---------|------|
| GET | `/api/items?q=&category_id=&location_id=&status=low\|expiring\|expired&barcode=` | Lista zasobów |
| POST | `/api/items` | Dodanie zasobu |
| GET / PUT / PATCH / DELETE | `/api/items/:id` | Odczyt / edycja / usunięcie |
| POST | `/api/items/:id/adjust` | Zmiana stanu `{ "delta": -1, "note": "..." }` |
| GET | `/api/items/:id/history` | Historia zmian stanu |
| GET / POST | `/api/categories`, `/api/locations` | Słowniki |
| DELETE | `/api/categories/:id`, `/api/locations/:id` | Usunięcie pozycji słownika |
| GET | `/api/barcode/:kod` lub `/api/barcode?code=` | Zasoby z danym kodem + podpowiedź produktu |
| POST / DELETE | `/api/items/:id/image` | Pobierz zdjęcie z Open Food Facts / usuń zdjęcie |
| POST | `/api/images/fill` | Pobierz brakujące zdjęcia dla wszystkich produktów z kodem |
| GET | `/images/:plik` | Zapisane zdjęcie produktu |
| POST | `/api/expiry/parse` | Data ważności z tekstu etykiety `{ "text": "..." }` → `{ "date": "2027-05-12" }` |
| GET | `/api/stats` | Statystyki pulpitu |
| GET | `/api/shopping-list` | Lista zakupów |
| GET / POST | `/api/export`, `/api/import` | Kopia zapasowa JSON |

Przykład:

```bash
curl -X POST localhost:3000/api/items -H 'Content-Type: application/json' \
  -d '{"name":"Mąka","quantity":2,"unit":"kg","min_quantity":1}'
```
