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

## Struktura projektu

```
src/
  db.js       – schemat bazy, walidacja i logika (klasa Store)
  app.js      – routing REST API i serwowanie plików statycznych
  server.js   – punkt startowy serwera HTTP
public/       – interfejs (HTML, CSS, JS bez frameworków)
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
