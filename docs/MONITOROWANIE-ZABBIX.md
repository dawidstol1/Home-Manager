# Monitorowanie w Zabbix 8.0 (OpenTelemetry / APM)

Aplikacja ma wbudowane **OpenTelemetry**. Wysyła:

| Rodzaj | Co zawiera |
|---|---|
| **Ślady (traces)** | każde żądanie API (`GET /api/items`, `POST /api/medicines/:id/take`…) z czasem trwania, kodem odpowiedzi i **zapytaniami do PostgreSQL** jako pod-krokami; zapytania do Open Food Facts |
| **Metryki** | czas odpowiedzi HTTP (`http.server.request.duration`), czas zapytań do bazy, połączenia z bazą, stan domu (niżej), liczniki logowań, zmian stanu i podań leków |
| **Logi** | komunikaty serwera (start, błędy z pełnym opisem) – powiązane ze śladem, w którym wystąpiły |

Bez konfiguracji telemetria jest wyłączona i nic nie kosztuje.

Są dwa sposoby – wybierz jeden:

| | **A. Bez ClickHouse** (zalecane w domu) | **B. Zabbix APM** |
|---|---|---|
| Co trzeba mieć | dowolny Zabbix (6.4, 7.x, 8.0) | Zabbix 8.0 + proxy z APM + baza **ClickHouse** |
| Co widać | stan aplikacji i bazy, metryki, wykresy, alarmy | to samo + **ślady** każdego żądania i logi w sekcji APM |
| Jak | gotowy szablon do zaimportowania | wysyłka OTLP/gRPC do proxy |

---

## A. Bez ClickHouse: szablon „Zasoby domowe by HTTP”

Zabbix sam co minutę pobiera z aplikacji dwa adresy: `/api/health` (czy aplikacja i baza działają) i `/metrics`
(metryki OpenTelemetry w formacie Prometheus). Nie trzeba proxy APM ani ClickHouse.

### A1. Aplikacja: włącz metryki Prometheus

W `/etc/home-manager/home-manager.env` na serwerze aplikacji dopisz:

```bash
OTEL_METRICS_EXPORTER=prometheus
OTEL_EXPORTER_PROMETHEUS_PORT=9464
```

i uruchom ponownie:

```bash
cd /opt/home-manager && git pull && npm ci --omit=dev
systemctl restart home-manager
curl -s http://127.0.0.1:9464/metrics | grep home_manager_items
curl -s http://127.0.0.1/api/health
```

Pierwsze `curl` pokaże np. `home_manager_items{…} 11`, drugie `{"status":"ok",…}`.

Port 9464 nie wymaga logowania – w zaporze otwórz go tylko dla serwera (albo proxy) Zabbix:
`ufw allow from ADRES_ZABBIX to any port 9464 proto tcp`.

### A2. Zabbix: import szablonu

1. Pobierz plik [`deploy/zabbix/zasoby-domowe-template.yaml`](../deploy/zabbix/zasoby-domowe-template.yaml)
   (na GitHubie: przycisk *Download raw file*).
2. Zabbix → **Zbieranie danych → Szablony → Importuj** → wybierz plik → **Importuj**.
3. **Zbieranie danych → Hosty → Utwórz host**:
   - Nazwa: `Zasoby domowe`, grupa np. `Applications`,
   - Szablony: **Zasoby domowe by HTTP**,
   - zakładka **Makra** – wpisz adresy aplikacji (tak, jak Zabbix je widzi):

| Makro | Przykład | Opis |
|---|---|---|
| `{$HM.URL}` | `http://10.20.1.30` | adres aplikacji (przez nginx w kontenerze; bez `/` na końcu) |
| `{$HM.METRICS.URL}` | `http://10.20.1.30:9464/metrics` | metryki Prometheus |
| `{$HM.INTERVAL}` | `1m` | co ile pobierać |

4. Po minucie: **Monitorowanie → Najnowsze dane** → host `Zasoby domowe`.

### Co jest w szablonie

**Pozycje:** stan aplikacji, wersja, czas odpowiedzi bazy, baza dostępna, połączenia czekające na bazę, żądania HTTP
na sekundę, nieudane i zablokowane logowania, produkty / do kupienia / po terminie / tracące ważność, leki / po terminie /
kończący się termin / mało, gwarancje i przeglądy, wydatki i zmarnowane w miesiącu (zł).

**Wyzwalacze:**

| Wyzwalacz | Ważność |
|---|---|
| aplikacja albo baza nie działa (`/api/health` ≠ ok) | Wysoka |
| aplikacja nie odpowiada od 5 min | Wysoka |
| brak połączenia z bazą przez 3 min | Wysoka |
| za mało połączeń z bazą | Średnia |
| zablokowano logowania (ktoś zgaduje hasła) | Średnia |
| baza odpowiada wolno (> 0,5 s) | Ostrzeżenie |
| produkty po terminie, leki po terminie | Ostrzeżenie |
| do kupienia, kończą się leki, gwarancje i przeglądy | Informacja |

**Wykresy:** terminy, wydatki i zmarnowane, ruch aplikacji i czas odpowiedzi bazy.

Nie chcesz alarmów o domowych sprawach (np. „do kupienia”)? Wyłącz je w hoście: **Wyzwalacze** → zaznacz → *Wyłącz*.

---

## B. Zabbix 8.0 APM (z ClickHouse)

### B1. Zabbix 8.0: proxy przyjmujące OpenTelemetry

W Zabbix 8.0 dane OpenTelemetry (OTLP/gRPC) przyjmuje **proxy Zabbix z obsługą APM**, a zapisuje je baza **ClickHouse**.
Instrukcja Zabbixa: [What's new 8.0](https://www.zabbix.com/documentation/8.0/en/manual/whatsnew) ·
[integracja OpenTelemetry](https://www.zabbix.com/integrations/opentelemetry).

W skrócie:
1. Zainstaluj proxy Zabbix 8.0 **w wersji z APM** (pakiety proxy z obsługą APM – patrz uwagi do instalacji pakietów
   w dokumentacji Zabbixa) i skonfiguruj ClickHouse jako źródło danych telemetrii.
2. W interfejsie Zabbix: **Administracja → Proxy →** Twoje proxy → zakładka **APM** – włącz odbiór OTLP/gRPC
   (standardowo port **4317**).
3. Sprawdź, że kontener z aplikacją widzi ten port: `nc -zv ADRES_PROXY 4317`.

### B2. Aplikacja: dokąd wysyłać

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

### B3. Zabbix: host i szablon

1. **Zbieranie danych → Hosty → Utwórz host**: nazwa np. `Zasoby domowe`, monitorowany przez proxy z punktu 1.
2. Dołącz szablon **Generic OpenTelemetry by OTLP** (wbudowany w Zabbix 8.0).
3. Ślady zobaczysz w nowej sekcji **APM** interfejsu Zabbix (usługa `home-manager`): czasy odpowiedzi, błędy,
   najwolniejsze żądania i zapytania do bazy.
4. Własne wykresy i wyzwalacze z metryk aplikacji tworzysz pozycjami typu **telemetry query** (nowy typ w 8.0)
   – nazwy metryk niżej.

#### Metryki aplikacji

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

Oba sposoby można łączyć: `OTEL_METRICS_EXPORTER=otlp,prometheus` wysyła metryki do APM i jednocześnie wystawia `/metrics`.
