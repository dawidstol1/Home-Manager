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
| Akcje: zużycie po kodzie, podanie leku | ✅ | – |

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

**Opcje** (Konfiguruj przy integracji):
- *Pokaż aplikację w menu bocznym* – włącz/wyłącz panel.
- *Adres aplikacji w menu* – gdy telefon ma otwierać aplikację pod innym adresem niż ten z konfiguracji
  (np. integracja łączy się przez `http://192.168.1.30`, a z telefonu poza domem otwierasz `https://zasoby.example.pl`).
- *Odświeżanie czujników* – co ile minut (domyślnie 5).

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
