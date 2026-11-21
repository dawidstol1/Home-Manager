# Integracje: Home Assistant i Domoticz

Wtyczki łączą Twoje **istniejące** Home Assistant i Domoticz z serwerem aplikacji Zasoby domowe.
Niczego nowego nie trzeba stawiać w homelabie.

| | Home Assistant | Domoticz |
|---|---|---|
| Cała aplikacja w menu (zasoby, apteka, kalendarz, zakupy…) | ✅ pozycja „Zasoby domowe” w bocznym menu, także w aplikacji HA na telefonie | ✅ zakładka **Custom → ZasobyDomowe** |
| Czujniki: do kupienia, po terminie, leki, gwarancje, wydatki, wpisy dziś | ✅ | ✅ (urządzenia „Custom sensor”) |
| „Wymaga uwagi” do automatyzacji i powiadomień | ✅ czujnik binarny | ✅ urządzenie „Alert” |
| Kalendarz domowy | ✅ zakładka Kalendarz (podgląd, dodawanie, usuwanie) | tekst „Dziś w kalendarzu” |
| Lista zakupów | ✅ lista zadań – odhaczenie = kupione | tekst „Lista zakupów” |
| Każdy produkt i lek jako encja (ilość, termin, miejsce, ostatnie podanie) + przyciski „Zużyj 1” / „Podaj dawkę” | ✅ | – |
| Akcje: zużyj / wyrzuć / dodaj, znajdź produkt lub lek „na gorączkę”, dodaj produkt, dodaj opakowanie leku, podaj lek, zużycie po kodzie | ✅ | – |
| Komendy głosowe po polsku (Asystent): „ile mamy mleka”, „co mamy na gorączkę”, „podaj ibuprom dla Zosi”… | ✅ | – |

---

## Krok 1 – w aplikacji Zasoby domowe

1. Otwórz aplikację → **Ustawienia → Integracje**.
2. **Klucz dla wtyczki:** wpisz nazwę (np. „Home Assistant”) → **Utwórz klucz** → skopiuj klucz (`hm_…`).
   Klucz widać tylko raz. Na każdą wtyczkę zrób osobny klucz – łatwo go potem wyłączyć.
3. **Gdzie wolno pokazać aplikację** (tylko administrator): wpisz adresy, pod którymi otwierasz Home Assistant
   i Domoticz, po jednym w linii, np.:
   ```
   http://192.168.1.10:8123
   https://ha.example.pl
   http://192.168.1.11:8080
   ```
   Bez tego przeglądarka nie pokaże aplikacji w menu HA/Domoticza (ochrona przed podszywaniem się innych stron).
   Wpisz dokładnie to, co widzisz w pasku adresu (http/https i port).

> **HTTPS:** jeśli Home Assistant otwierasz przez `https://`, aplikacja też musi mieć `https://`
> (przeglądarka nie pokaże strony `http://` wewnątrz strony `https://`). Instrukcja HTTPS: `docs/INSTALACJA-UBUNTU.md`, krok 2.6.

---

## Krok 2a – Home Assistant

### Instalacja przez HACS (zalecane)

1. HACS → menu ⋮ → **Niestandardowe repozytoria** → adres `https://github.com/dawidstol1/Home-Manager`, typ **Integracja** → Dodaj.
2. Wyszukaj **Zasoby domowe (Home-Manager)** → Pobierz → uruchom ponownie Home Assistant.

### Instalacja ręczna

Skopiuj katalog `custom_components/home_manager` z repozytorium do `config/custom_components/` w Home Assistant
(np. przez dodatek „File editor”/„Samba” albo `scp`) i uruchom ponownie Home Assistant.

### Konfiguracja

1. **Ustawienia → Urządzenia i usługi → Dodaj integrację → Zasoby domowe**.
2. **Adres serwera** – adres, pod którym *Home Assistant* widzi aplikację, np. `http://192.168.1.30`.
3. **Klucz API** – klucz z kroku 1.
4. Gotowe: w bocznym menu pojawi się **Zasoby domowe** (cała aplikacja), a w urządzeniach – „Zasoby domowe” z czujnikami.

Aplikacja w menu otwiera się **przez Home Assistant** – działa wszędzie tam, gdzie działa HA: w domu, przez
Nginx Proxy Manager, Nabu Casa i w aplikacji HA na telefonie poza domem. Nie trzeba wystawiać aplikacji osobno
do internetu ani dopisywać adresu HA w „Gdzie wolno pokazać aplikację”. Dostęp mają tylko zalogowani użytkownicy HA.

**Opcje** (Konfiguruj przy integracji):
- *Pokaż aplikację w menu bocznym* – włącz/wyłącz panel.
- *Otwieraj aplikację przez Home Assistant* – domyślnie włączone (zalecane).
- *Adres aplikacji w menu* – tylko gdy wyłączysz poprzednią opcję: telefon otwiera wtedy aplikację bezpośrednio pod
  tym adresem (musi być osiągalny z telefonu i mieć `https://`, jeśli HA ma `https://`; dodaj adres HA w aplikacji
  w „Gdzie wolno pokazać aplikację”).
- *Odświeżanie czujników* – co ile minut (domyślnie 5).
- *Czujnik i przycisk dla każdego produktu* – wyłącz, jeśli masz bardzo dużo produktów (leki zostają).
- *Polskie komendy dla Asystenta* – włącz/wyłącz komendy głosowe.

W menu aplikacja pyta o login – każdy domownik loguje się swoim kontem (na telefonie i komputerze osobno; logowanie jest zapamiętywane).

### Co dostajesz

| Encja | Co pokazuje |
|---|---|
| `sensor.zasoby_domowe_do_kupienia` | liczba pozycji do kupienia (lista w atrybucie `items`) |
| `sensor.zasoby_domowe_produkty_po_terminie`, `…_konczy_sie_waznosc_7_dni` | terminy produktów |
| `sensor.zasoby_domowe_leki_po_terminie`, `…_leki_konczy_sie_termin`, `…_leki_malo`, `…_leki_w_apteczce` | domowa apteka |
| `sensor.zasoby_domowe_gwarancje_i_przeglady` | gwarancje kończące się w 30 dni + zaległe/bliskie przeglądy |
| `sensor.zasoby_domowe_wydatki_w_tym_miesiacu`, `…_zmarnowane_w_tym_miesiacu` | zł |
| `sensor.zasoby_domowe_wpisy_w_kalendarzu_dzis` | wpisy na dziś (lista w atrybucie `events`) |
| `binary_sensor.zasoby_domowe_wymaga_uwagi` | włączony, gdy coś jest po terminie albo czeka przegląd (opis w `problems`) |
| `calendar.zasoby_domowe_kalendarz_domowy` | wspólne wpisy + Twoje prywatne + terminy z domu |
| `todo.zasoby_domowe_lista_zakupow` | odhaczenie pozycji = „kupione” (stan w aplikacji rośnie) |

Nazwy encji zależą od języka Home Assistant – powyżej dla polskiego.

**Każdy produkt i lek** (urządzenia „Zasoby domowe – produkty” i „Zasoby domowe – apteka”):

| Encja | Co pokazuje / robi |
|---|---|
| `sensor.zasoby_domowe_produkty_mleko` | ilość (np. `2 l`), zdjęcie produktu; atrybuty: miejsce, kategoria, termin, niski stan, kod |
| `button.zasoby_domowe_produkty_mleko_zuzyj_1` | zdejmuje 1 szt. (z partii o najkrótszym terminie) |
| `sensor.zasoby_domowe_apteka_paracetamol` | ilość leku; atrybuty: na co, dla kogo, gdzie leży, dawkowanie, termin, kiedy i komu ostatnio podany |
| `button.zasoby_domowe_apteka_paracetamol_podaj_dawke` | zapisuje podanie jednej dawki (1 tabl. / 5 ml) |

Nowe produkty i leki dodane w aplikacji pojawiają się w HA same przy najbliższym odświeżeniu. Taki przycisk albo
czujnik możesz położyć na pulpicie (karta „Encja”/„Przycisk”) – np. „Podaj dawkę” syropu dla dziecka przy łóżeczku.

### Komendy głosowe (Asystent, po polsku)

Działają w Asystencie Home Assistant (aplikacja na telefonie, głośniki z Assist). Nazwy można mówić w dowolnej formie –
„mleka”, „ibupromu”, „dla Zosi”.

| Powiedz | Odpowiedź / działanie |
|---|---|
| „ile mamy mleka”, „czy mamy jeszcze jogurt” | ilość, miejsce i termin |
| „co mamy na gorączkę”, „co mogę dać na ból zęba” | leki z apteczki opisane „na co” |
| „podaj ibuprom dla Zosi”, „podaj Zosi paracetamol” | zapis podania jednej dawki w dzienniku |
| „co jest do kupienia”, „czego brakuje” | lista zakupów |
| „co mamy dziś w kalendarzu”, „jakie plany na jutro” | wspólne wpisy (prywatnych nie czyta na głos) |
| „zużyj jogurt”, „wyrzuć ser” | −1 szt. (wyrzucone trafia do „zmarnowanych”) |
| „co jest po terminie” | produkty i leki po terminie |

### Akcje do automatyzacji i skryptów

| Akcja | Co robi |
|---|---|
| `home_manager.adjust_item` | `item: mleko`, `amount: 1`, `mode: used / wasted / add` |
| `home_manager.add_item` | nowy produkt (nazwa, ilość, jednostka, kategoria, miejsce, termin, kod) |
| `home_manager.find_items` | zwraca produkty (`query`, `status: low / expiring / expired`) |
| `home_manager.find_medicines` | zwraca leki po nazwie albo „na co” (`query: gorączka`) |
| `home_manager.take_medicine` | podanie leku (`medicine`, `amount`, `person`, `note`) |
| `home_manager.add_medicine_pack` | nowe opakowanie leku z terminem |
| `home_manager.consume_barcode` | −1 szt. po kodzie kreskowym (np. z czytnika) |

Akcje `find_*` zwracają dane (`response_variable`) – można je wykorzystać w powiadomieniu albo w odpowiedzi Asystenta.

### Przykładowe automatyzacje

Powiadomienie rano, gdy coś jest po terminie:

```yaml
automation:
  - alias: "Zasoby: coś po terminie"
    triggers:
      - trigger: time
        at: "08:00:00"
    conditions:
      - condition: state
        entity_id: binary_sensor.zasoby_domowe_wymaga_uwagi
        state: "on"
    actions:
      - action: notify.mobile_app_moj_telefon
        data:
          title: "Zasoby domowe"
          message: "{{ state_attr('binary_sensor.zasoby_domowe_wymaga_uwagi', 'problems') | join(', ') }}"
```

Podanie leku przyciskiem (np. z karty na pulpicie):

```yaml
action: home_manager.take_medicine
data:
  medicine: "Ibuprom dla dzieci Forte"
  amount: 5
  person: "Zosia"
  note: "gorączka"
```

Zużycie produktu po kodzie z czytnika:

```yaml
action: home_manager.consume_barcode
data:
  barcode: "5900512300108"
  reason: used      # albo wasted – trafi do „zmarnowanych”
```

---

### Home Assistant za Nginx Proxy Manager (dostęp z internetu)

Jeśli `https://twoja-domena` pokazuje **„400: Bad Request”**, Home Assistant nie ufa proxy. To ustawienie samego HA:

1. **Home Assistant → `configuration.yaml`** (np. dodatkiem *File editor*):
   ```yaml
   http:
     use_x_forwarded_for: true
     trusted_proxies:
       - 192.168.1.50        # adres IP serwera/kontenera z Nginx Proxy Manager
   ```
   - NPM w Dockerze na tym samym serwerze co HA → wpisz sieć Dockera, np. `172.16.0.0/12`.
   - Masz już sekcję `http:` → dopisz te dwie opcje do niej (nie twórz drugiej).
   - Nie znasz adresu? Po wejściu przez domenę: **Ustawienia → System → Logi** – HA wypisze
     „A request from a reverse proxy was received from **172.18.0.5**…”. Ten adres wpisz.
2. **Uruchom ponownie Home Assistant** (Ustawienia → System → ⋮ → Uruchom ponownie).
3. **Nginx Proxy Manager → Hosts → Proxy Hosts →** host HA → *Edit*:
   - *Details*: Scheme `http`, Forward Hostname/IP = adres HA, Forward Port `8123`,
     ✅ **Websockets Support** (bez tego HA zawiesza się na „Ładowanie danych”), ✅ Block Common Exploits.
   - *SSL*: certyfikat Let's Encrypt, ✅ Force SSL, ✅ HTTP/2 Support.
   - *Advanced*: nic nie trzeba wpisywać.
4. W aplikacji Home Assistant na telefonie: **Ustawienia → Aplikacja → Serwer → Adres zewnętrzny** = `https://twoja-domena`.

Aplikacji Zasoby domowe **nie trzeba** wystawiać w NPM – panel „Zasoby domowe” idzie przez Home Assistant.

---

## Krok 2b – Domoticz

Wymaga Domoticza z obsługą wtyczek Python (standardowo w wersjach 2020+).

1. Skopiuj katalog `integrations/domoticz/HomeManager` do katalogu `plugins` Domoticza, np.:
   ```bash
   cd /home/pi/domoticz/plugins        # albo /opt/domoticz/plugins, /config/plugins w Dockerze
   git clone --depth 1 https://github.com/dawidstol1/Home-Manager.git /tmp/hm
   cp -r /tmp/hm/integrations/domoticz/HomeManager .
   sudo systemctl restart domoticz
   ```
2. Domoticz → **Konfiguracja → Sprzęt** → Typ: **Zasoby domowe (Home-Manager)**:
   - *Adres aplikacji*: np. `http://192.168.1.30`,
   - *Klucz API*: klucz z kroku 1,
   - *Odświeżanie*: 5 minut,
   - *Strona w menu Custom*: Tak.
3. **Dodaj**. Urządzenia pojawią się w zakładce **Narzędzia** (Utility), a aplikacja – w menu **Custom → ZasobyDomowe**.

Urządzenia: Do kupienia, Produkty po terminie, Kończy się ważność, Leki w apteczce, Leki po terminie,
Leki – kończy się termin, Leki – mało, Gwarancje i przeglądy, Wpisy w kalendarzu dziś, Wydatki i Zmarnowane w tym
miesiącu (zł), **Wymaga uwagi** (Alert: zielony → czerwony), **Lista zakupów** i **Dziś w kalendarzu** (tekst).

Gdy serwer nie odpowiada albo klucz został usunięty, urządzenia są oznaczane jako nieaktualne (czerwony pasek),
a powód widać w **Konfiguracja → Log**.

---

## Bezpieczeństwo

- Home Assistant widzi to, co konto, które utworzyło klucz (także jego prywatne wpisy w kalendarzu – w HA
  oznaczone kłódką 🔒). Komendy głosowe nie czytają prywatnych wpisów. Jeśli nie chcesz, żeby prywatne wpisy były
  w HA, utwórz klucz z osobnego konta domownika, np. „Dom”.
- Klucz API działa jak konto, które go utworzyło, ale **nie może** zmieniać haseł, kont, kluczy, adresów osadzania
  ani importować kopii zapasowej. Usunięcie klucza w Ustawieniach od razu odcina wtyczkę.
- W bazie zapisany jest tylko skrót klucza.
- Aplikację można osadzić w ramce wyłącznie na stronach z listy „Gdzie wolno pokazać aplikację”.

## Testy (dla programistów)

```bash
# serwer aplikacji wymaga PostgreSQL (jak `npm test`)
python -m venv .venv && . .venv/bin/activate
pip install pytest-homeassistant-custom-component
cd integrations/home_assistant && python -m pytest          # prawdziwy Home Assistant + serwer aplikacji
cd ../domoticz && PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests
```
