# Monitorowanie w Zabbix 8.0 (OpenTelemetry / APM)

Aplikacja ma wbudowane **OpenTelemetry**. Wysyła:

| Rodzaj | Co zawiera |
|---|---|
| **Ślady (traces)** | każde żądanie API (`GET /api/items`, `POST /api/medicines/:id/take`…) z czasem trwania, kodem odpowiedzi i **zapytaniami do PostgreSQL** jako pod-krokami; zapytania do Open Food Facts |
| **Metryki** | czas odpowiedzi HTTP (`http.server.request.duration`), czas zapytań do bazy, połączenia z bazą, stan domu (niżej), liczniki logowań, zmian stanu i podań leków |
| **Logi** | komunikaty serwera (start, błędy z pełnym opisem) – powiązane ze śladem, w którym wystąpiły |

Bez konfiguracji telemetria jest wyłączona i nic nie kosztuje.

---

## 1. Zabbix 8.0: proxy przyjmujące OpenTelemetry

W Zabbix 8.0 dane OpenTelemetry (OTLP/gRPC) przyjmuje **proxy Zabbix z obsługą APM**, a zapisuje je baza **ClickHouse**.
Instrukcja Zabbixa: [What's new 8.0](https://www.zabbix.com/documentation/8.0/en/manual/whatsnew) ·
[integracja OpenTelemetry](https://www.zabbix.com/integrations/opentelemetry).

W skrócie:
1. Zainstaluj proxy Zabbix 8.0 **w wersji z APM** (pakiety proxy z obsługą APM – patrz uwagi do instalacji pakietów
   w dokumentacji Zabbixa) i skonfiguruj ClickHouse jako źródło danych telemetrii.
2. W interfejsie Zabbix: **Administracja → Proxy →** Twoje proxy → zakładka **APM** – włącz odbiór OTLP/gRPC
   (standardowo port **4317**).
3. Sprawdź, że kontener z aplikacją widzi ten port: `nc -zv ADRES_PROXY 4317`.

## 2. Aplikacja: dokąd wysyłać

W `/etc/home-manager/home-manager.env` dopisz (adres proxy Zabbix zamiast `192.168.1.40`):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://192.168.1.40:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_SERVICE_NAME=home-manager
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=dom,host.name=zasoby
```

i uruchom ponownie:

```bash
cd /opt/home-manager && git pull && npm ci --omit=dev
systemctl restart home-manager
journalctl -u home-manager -n 5 --no-pager
```

W logu pojawi się `OpenTelemetry: wysyłam do http://192.168.1.40:4317 (grpc)`.

Inne przydatne zmienne (standard OpenTelemetry):

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | co ile ms wysyłać metryki |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | wszystkie | np. `traceidratio` / `0.2` – tylko 20% śladów |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER` | `otlp` | `none` wyłącza ślady albo logi |
| `OTEL_SDK_DISABLED` | – | `true` wyłącza całą telemetrię |

## 3. Zabbix: host i szablon

1. **Zbieranie danych → Hosty → Utwórz host**: nazwa np. `Zasoby domowe`, monitorowany przez proxy z punktu 1.
2. Dołącz szablon **Generic OpenTelemetry by OTLP** (wbudowany w Zabbix 8.0).
3. Ślady zobaczysz w nowej sekcji **APM** interfejsu Zabbix (usługa `home-manager`): czasy odpowiedzi, błędy,
   najwolniejsze żądania i zapytania do bazy.
4. Własne wykresy i wyzwalacze z metryk aplikacji tworzysz pozycjami typu **telemetry query** (nowy typ w 8.0)
   – nazwy metryk niżej.

### Metryki aplikacji

| Metryka | Co mierzy | Przykładowy wyzwalacz |
|---|---|---|
| `home_manager.db.up` | baza odpowiada (1) / nie (0) | `= 0` przez 3 min → **Wysoki** |
| `home_manager.db.pool.connections` (`state`: total, idle, waiting) | połączenia z bazą | `waiting > 5` → za mało połączeń |
| `http.server.request.duration` | czas odpowiedzi API (histogram, sekundy) | p95 > 1 s |
| `home_manager.login.attempts` (`result`: success, failure, blocked) | logowania | `blocked` rośnie → ktoś zgaduje hasła |
| `home_manager.items` | produkty w zasobach | – |
| `home_manager.items.low_stock` | do kupienia | > 0 → informacja |
| `home_manager.items.expired` | produkty po terminie | > 0 → ostrzeżenie |
| `home_manager.items.expiring_soon` | tracą ważność w 7 dni | – |
| `home_manager.medicines` / `.expired` / `.expiring` / `.low` | domowa apteka | `.expired` > 0 → ostrzeżenie |
| `home_manager.equipment.attention` | gwarancje kończące się w 30 dni + przeglądy | > 0 → informacja |
| `home_manager.spent.month` / `home_manager.wasted.month` | zł w bieżącym miesiącu | – |
| `home_manager.stock.changes` (`reason`: purchase, used, wasted, correction) | zmiany stanu | – |
| `home_manager.medicine.doses` | zapisane podania leków | – |

Stan domu odczytywany jest najczęściej co 30 s, więc obciążenie bazy jest pomijalne.

---

## 4. Prosty test „czy działa” (każda wersja Zabbixa)

Niezależnie od APM aplikacja ma adres **`/api/health`** (bez logowania):

```json
{"status":"ok","database":"ok","database_ms":2,"version":"1.0.0","uptime_s":3600}
```

Gdy baza nie odpowiada – kod **503** i `"status":"error"`.

W Zabbix: host `Zasoby domowe` → **Pozycje → Utwórz pozycję**:
- Typ: **HTTP agent**, klucz `home_manager.health`, URL `http://ADRES_APLIKACJI:3000/api/health`
  (albo `https://twoja-domena/api/health`), interwał `1m`,
- Kody statusu: `200,503`, Typ informacji: **Tekst**,
- Wstępne przetwarzanie: **JSONPath** `$.status`.

Wyzwalacz: `last(/Zasoby domowe/home_manager.health)<>"ok"` – ważność **Wysoka**
(oraz `nodata(/Zasoby domowe/home_manager.health,5m)=1` – aplikacja nie odpowiada wcale).

## 5. Bez proxy APM: metryki w formacie Prometheus

Jeśli wolisz zwykłe pozycje Zabbixa (działa też w Zabbix 6/7), włącz dodatkowo endpoint Prometheus:

```bash
OTEL_METRICS_EXPORTER=otlp,prometheus      # albo samo: prometheus
OTEL_EXPORTER_PROMETHEUS_PORT=9464
OTEL_EXPORTER_PROMETHEUS_HOST=0.0.0.0      # nasłuch dla Zabbixa (domyślnie wszystkie interfejsy)
```

Metryki są wtedy pod `http://ADRES_APLIKACJI:9464/metrics`, z kropkami zamienionymi na podkreślenia
(`home_manager_items_expired`, `home_manager_db_up`…). W Zabbix: pozycja **HTTP agent** z tym adresem
(Typ informacji: Tekst) + pozycje zależne z przetwarzaniem **Prometheus pattern**, np. `home_manager_items_expired`.

Port 9464 nie wymaga logowania – w zaporze otwórz go tylko dla serwera/proxy Zabbix:
`ufw allow from ADRES_ZABBIX to any port 9464 proto tcp`.
