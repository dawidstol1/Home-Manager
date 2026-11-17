# Podgląd w przeglądarce

Buduje jedną stronę, na której działa **prawdziwy kod serwera** (`src/db.js`, `src/app.js`, `src/auth.js`…)
z bazą PostgreSQL uruchomioną w przeglądarce ([PGlite](https://pglite.dev), PostgreSQL w WebAssembly).
Żądania `fetch('/api/…')` interfejsu trafiają do tego serwera zamiast do sieci; dane są przykładowe i znikają po odświeżeniu.

```bash
cd tools/preview
npm install
npm run build        # wynik w out/: index.html + pliki bazy w out/pglite/ i zdjęcia w out/images/
```

`out/` można wystawić dowolnym serwerem plików statycznych (np. `npx serve out`).

Pliki:
- `entry.js` – start bazy, dane przykładowe, przechwytywanie `fetch` i wywołanie serwera,
- `pg-shim.js` – zamiennik sterownika `pg` oparty na PGlite,
- `shims/` – zamienniki modułów Node (`crypto`, `fs` w pamięci, `util`, `Buffer`),
- `demo/` – produkty i zdjęcia z Open Food Facts do danych przykładowych.
