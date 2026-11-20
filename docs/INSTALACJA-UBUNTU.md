# Instalacja na Ubuntu 26.04 (LXC) bez Dockera

Ta instrukcja zakłada **dwa serwery**:

| Serwer | Co na nim działa | Przykładowy adres |
|---|---|---|
| **Serwer bazy danych** | PostgreSQL | `192.168.1.20` |
| **Kontener LXC z Ubuntu 26.04** | aplikacja (Node.js) i nginx z HTTPS | `192.168.1.30` |

Zamień przykładowe adresy, hasła i domenę (`zasoby.example.pl`) na swoje. Polecenia wykonujesz jako `root` (albo dopisz `sudo`).

---

## Część 1 – serwer PostgreSQL

Jeśli PostgreSQL już tam działa, pomiń instalację i zacznij od kroku 1.2.

### 1.1. Instalacja (gdy go jeszcze nie ma)

```bash
apt update
apt install -y postgresql
```

### 1.2. Użytkownik i baza dla aplikacji

Wymyśl mocne hasło. Wygenerujesz je np. tak: `openssl rand -base64 24`.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE homemanager LOGIN PASSWORD 'TU_WPISZ_HASLO';
CREATE DATABASE homemanager OWNER homemanager;
SQL
```

Tabele tworzy sama aplikacja przy pierwszym uruchomieniu. Nie musisz niczego importować.

### 1.3. Dostęp z kontenera aplikacji

Sprawdź wersję PostgreSQL (np. `16` albo `18`). Zastąp nią `XX` w ścieżkach poniżej:

```bash
ls /etc/postgresql/
```

**a) PostgreSQL ma przyjmować połączenia z sieci.** W pliku `/etc/postgresql/XX/main/postgresql.conf` ustaw:

```
listen_addresses = '*'
ssl = on
```

**b) Tylko kontener aplikacji może się logować, i tylko po szyfrowanym połączeniu.** Dopisz na końcu pliku `/etc/postgresql/XX/main/pg_hba.conf`:

```
hostssl  homemanager  homemanager  192.168.1.30/32  scram-sha-256
```

**c) Uruchom PostgreSQL ponownie:**

```bash
systemctl restart postgresql
```

**d) Zapora (jeśli używasz `ufw`).** Port 5432 otwierasz tylko dla kontenera aplikacji:

```bash
ufw allow from 192.168.1.30 to any port 5432 proto tcp
```

---

## Część 2 – kontener LXC z aplikacją (Ubuntu 26.04)

### 2.1. Pakiety systemowe i Node.js

Aplikacja potrzebuje Node.js w wersji **22 lub nowszej**. Najpierw sprawdź, co oferuje Ubuntu:

```bash
apt update
apt install -y git nginx postgresql-client ca-certificates curl
apt-cache policy nodejs | head -3
```

**Jeśli „Candidate” to 22.x lub wyższa:**

```bash
apt install -y nodejs npm
```

**W przeciwnym razie zainstaluj Node.js 24 LTS z repozytorium NodeSource:**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt install -y nodejs
```

Na koniec sprawdź wersję. Powinna być `v22…` albo wyższa:

```bash
node -v
```

### 2.2. Sprawdzenie połączenia z bazą

To polecenie zapyta o hasło z kroku 1.2:

```bash
psql "postgres://homemanager@192.168.1.20:5432/homemanager?sslmode=require" -c "select version();"
```

Jeśli widzisz wersję PostgreSQL, połączenie działa. Jeśli nie, wróć do kroku 1.3.

### 2.3. Użytkownik systemowy, katalogi i kod aplikacji

```bash
useradd --system --home /var/lib/home-manager --shell /usr/sbin/nologin homemanager
mkdir -p /var/lib/home-manager/images /var/lib/home-manager/uploads /etc/home-manager
chown -R homemanager:homemanager /var/lib/home-manager

git clone https://github.com/dawidstol1/Home-Manager.git /opt/home-manager
cd /opt/home-manager
npm ci --omit=dev
```

### 2.4. Konfiguracja

```bash
cp /opt/home-manager/deploy/home-manager.env.example /etc/home-manager/home-manager.env
nano /etc/home-manager/home-manager.env
```

W pliku zmień przede wszystkim `DATABASE_URL`: wpisz **hasło** i **adres serwera bazy**. Opis każdej opcji jest w komentarzach.

Plik zawiera hasło do bazy, więc ogranicz do niego dostęp:

```bash
chown root:homemanager /etc/home-manager/home-manager.env
chmod 640 /etc/home-manager/home-manager.env
```

> **Szyfrowanie połączenia z bazą.** `sslmode=no-verify` szyfruje połączenie, ale nie sprawdza certyfikatu serwera. W domowej sieci to wystarczy.
>
> Jeśli chcesz pełnej weryfikacji:
> 1. Skopiuj certyfikat z serwera bazy (`/etc/ssl/certs/ssl-cert-snakeoil.pem`) do `/etc/home-manager/pg.crt`.
> 2. W `DATABASE_URL` zamień końcówkę na `?sslmode=verify-full&sslrootcert=/etc/home-manager/pg.crt`.
> 3. Łącz się po **nazwie hosta** zapisanej w tym certyfikacie, a nie po adresie IP.

### 2.5. Usługa systemd (start razem z kontenerem)

```bash
cp /opt/home-manager/deploy/home-manager.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now home-manager
systemctl status home-manager --no-pager
```

Logi zobaczysz poleceniem `journalctl -u home-manager -f`. Poprawny start wygląda tak:

```
Manager zasobów domowych działa: http://127.0.0.1:3000
Baza danych: postgres://homemanager:***@192.168.1.20:5432/homemanager?sslmode=no-verify
Brak kont – otwórz aplikację w przeglądarce i utwórz konto administratora.
```

### 2.6. nginx i HTTPS

HTTPS jest potrzebny do dwóch rzeczy:
- do skanowania kamerą na żywo w przeglądarce telefonu,
- do instalacji aplikacji na ekranie głównym (PWA).

```bash
cp /opt/home-manager/deploy/nginx-home-manager.conf /etc/nginx/sites-available/home-manager
nano /etc/nginx/sites-available/home-manager        # wpisz swoją domenę w server_name
ln -s /etc/nginx/sites-available/home-manager /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Wybierz wariant certyfikatu:

**Wariant A – domena widoczna z internetu** (port 80 przekierowany na ten kontener). Certyfikat Let's Encrypt:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d zasoby.example.pl
```

Certbot sam doda HTTPS do konfiguracji nginx i będzie odnawiał certyfikat.

**Wariant B – masz już reverse proxy z HTTPS** (np. Nginx Proxy Manager, Traefik, Caddy na innym serwerze):
1. Skieruj go na `http://192.168.1.30:80`.
2. Albo pomiń nginx w tym kontenerze: w pliku `.env` ustaw `HOST=0.0.0.0`, a proxy skieruj na `http://192.168.1.30:3000`.
3. Proxy musi przekazywać nagłówki `X-Forwarded-Proto` i `X-Forwarded-For`.
4. W ustawieniach proxy pozwól na pliki do 25 MB.

### 2.7. Pierwsze uruchomienie

1. Otwórz `https://zasoby.example.pl`.
2. Aplikacja poprosi o **utworzenie konta administratora**. Podaj imię, login i hasło.
3. W zakładce **Więcej → Domownicy** dodaj konta dla pozostałych osób w domu.
4. Na iPhonie w Safari wybierz **Udostępnij → Do ekranu początkowego**. Aplikacja będzie działać jak zwykła aplikacja.

---

## Aktualizacja do nowej wersji

```bash
cd /opt/home-manager
git pull
npm ci --omit=dev
systemctl restart home-manager
```

Zmiany w bazie danych (nowe tabele i kolumny) aplikacja wprowadza sama przy starcie. Dane zostają.

## Kopie zapasowe

Kopię trzeba robić z **dwóch** miejsc:

**1. Baza danych – na serwerze PostgreSQL.** Codziennie o 3:00, przechowywane 14 dni:

```bash
mkdir -p /var/backups/home-manager && chown postgres /var/backups/home-manager
cat > /etc/cron.d/home-manager-db <<'EOF'
0 3 * * * postgres pg_dump -Fc homemanager > /var/backups/home-manager/db-$(date +\%F).dump && find /var/backups/home-manager -name 'db-*.dump' -mtime +14 -delete
EOF
```

**2. Pliki (dokumenty i zdjęcia) – w kontenerze aplikacji:**

```bash
mkdir -p /var/backups/home-manager
cat > /etc/cron.d/home-manager-files <<'EOF'
30 3 * * * root tar -czf /var/backups/home-manager/files-$(date +\%F).tar.gz -C /var/lib/home-manager images uploads && find /var/backups/home-manager -name 'files-*.tar.gz' -mtime +14 -delete
EOF
```

Skopiuj `/var/backups/home-manager` z obu serwerów na inny dysk albo do chmury. Kopia leżąca na tym samym serwerze nie chroni przed awarią dysku.

**Odtworzenie bazy z kopii** (na serwerze bazy):

```bash
sudo -u postgres pg_restore --clean --if-exists -d homemanager /var/backups/home-manager/db-RRRR-MM-DD.dump
```

## Zapomniane hasło

Na kontenerze aplikacji:

```bash
cd /opt/home-manager
sudo -u homemanager env $(grep -v '^#' /etc/home-manager/home-manager.env | xargs) node src/cli.js list-users
sudo -u homemanager env $(grep -v '^#' /etc/home-manager/home-manager.env | xargs) node src/cli.js reset-password LOGIN
```

Drugie polecenie zapyta o nowe hasło i wyloguje tego użytkownika ze wszystkich urządzeń.

## Rozwiązywanie problemów

| Objaw | Co sprawdzić |
|---|---|
| `Czekam na PostgreSQL… (ECONNREFUSED)` w logach | `listen_addresses` i restart PostgreSQL (krok 1.3a), zapora (krok 1.3d) |
| `no pg_hba.conf entry for host` | wpis `hostssl` z adresem IP kontenera (krok 1.3b) |
| `password authentication failed` | hasło w `DATABASE_URL`; znaki specjalne w haśle zapisz jako `%40` (@), `%3A` (:), `%2F` (/) |
| `The server does not support SSL connections` | `ssl = on` w `postgresql.conf` |
| 502 Bad Gateway w przeglądarce | `systemctl status home-manager` i `journalctl -u home-manager -n 50` |
| „Żądanie z innej strony zostało zablokowane” | reverse proxy musi przekazywać oryginalny nagłówek `Host` albo `X-Forwarded-Host`; ustaw `TRUST_PROXY=1` |
| Błąd przy wysyłaniu dużego PDF | `client_max_body_size` w nginx (oraz limit w zewnętrznym proxy) |
| Skaner na telefonie nie włącza kamery na żywo | aplikacja musi być otwarta przez **https://**; bez HTTPS działa tylko „Zrób zdjęcie” |
