# Zasoby domowe (Home-Manager) – wtyczka Domoticz
#
# Pokazuje stan domu jako urządzenia (zakupy, terminy, apteczka, kalendarz, wydatki)
# i dodaje całą aplikację do menu „Custom” w Domoticzu.
"""
<plugin key="HomeManager" name="Zasoby domowe (Home-Manager)" author="Home-Manager" version="1.0.0"
        wikilink="https://github.com/dawidstol1/Home-Manager/blob/main/integrations/README.md"
        externallink="https://github.com/dawidstol1/Home-Manager">
    <description>
        <h2>Zasoby domowe</h2>
        Stan domu z aplikacji Zasoby domowe: lista zakupów, produkty po terminie, domowa apteka, kalendarz, wydatki.<br/>
        Klucz API utworzysz w aplikacji: <b>Ustawienia → Integracje → Utwórz klucz</b>.<br/>
        Żeby aplikacja otwierała się w menu <b>Custom</b>, dodaj adres Domoticza w aplikacji w „Gdzie wolno pokazać aplikację”.
    </description>
    <params>
        <param field="Address" label="Adres aplikacji" width="300px" required="true" default="http://192.168.1.30"/>
        <param field="Password" label="Klucz API (hm_…)" width="300px" required="true" default="" password="true"/>
        <param field="Mode1" label="Odświeżanie (minuty)" width="60px" required="true" default="5"/>
        <param field="Mode2" label="Strona w menu Custom" width="120px">
            <options>
                <option label="Tak" value="1" default="true"/>
                <option label="Nie" value="0"/>
            </options>
        </param>
        <param field="Mode3" label="Adres aplikacji dla przeglądarki (opcjonalnie)" width="300px" required="false" default=""/>
        <param field="Mode6" label="Logi" width="120px">
            <options>
                <option label="Normalne" value="0" default="true"/>
                <option label="Szczegółowe" value="1"/>
            </options>
        </param>
    </params>
</plugin>
"""

import json
import os
import queue
import threading
import urllib.error
import urllib.request

import Domoticz

PAGE_NAME = "ZasobyDomowe.html"

# Jednostka → (nazwa, Type, Subtype, opcje, ikona-typ)
COUNTERS = {
    1: ("Do kupienia", "low_stock", "poz."),
    2: ("Produkty po terminie", "expired", "poz."),
    3: ("Kończy się ważność (7 dni)", "expiring_soon", "poz."),
    4: ("Leki w apteczce", "medicines", "leki"),
    5: ("Leki po terminie", "med_expired", "leki"),
    6: ("Leki – kończy się termin", "med_expiring", "leki"),
    7: ("Leki – mało", "med_low", "leki"),
    8: ("Gwarancje i przeglądy", None, "szt."),
    9: ("Wpisy w kalendarzu dziś", "events_today", "wpisy"),
    10: ("Wydatki w tym miesiącu", "spent_month", "zł"),
    11: ("Zmarnowane w tym miesiącu", "wasted_month", "zł"),
}
UNIT_ALERT = 20
UNIT_SHOPPING = 21
UNIT_TODAY = 22


def fmt_num(value):
    """3 → '3', 2.5 → '2,5' (do opisów); stan liczników w formacie z kropką."""
    return ("%g" % value).replace(".", ",")


def describe(summary):
    """Poziom alertu (0–4) i krótki opis tego, co wymaga uwagi."""
    s = summary["stats"]
    parts = []
    if s["expired"]:
        parts.append("Po terminie: " + ", ".join(i["name"] for i in summary["expired_items"][:4]))
    if s["med_expired"]:
        parts.append("Leki po terminie: " + ", ".join(m["name"] for m in summary["medicines"]["expired"][:4]))
    if s["service_due"]:
        parts.append("Przeglądy: %d" % s["service_due"])
    if s["low_stock"]:
        parts.append("Do kupienia: %d" % s["low_stock"])
    if s["expiring_soon"]:
        parts.append("Kończy się ważność: %d" % s["expiring_soon"])
    if s["expired"] or s["med_expired"]:
        level = 4
    elif s["service_due"]:
        level = 3
    elif s["low_stock"] or s["expiring_soon"] or s["med_expiring"]:
        level = 2
    else:
        level = 1
    return level, ("; ".join(parts) if parts else "Wszystko w porządku")[:250]


def shopping_text(summary):
    items = summary["shopping"]
    if not items:
        return "Lista zakupów jest pusta"
    return "\n".join("%s – %s %s" % (i["name"], fmt_num(i["to_buy"]), i["unit"]) for i in items)[:2000]


def today_text(summary):
    events = summary["events_today"]
    if not events:
        return "Nic zaplanowanego na dziś"
    return "\n".join(("%s " % e["start_time"] if e.get("start_time") else "") + e["title"] for e in events)[:2000]


def page_html(url):
    """Strona w menu Custom: cała aplikacja w ramce."""
    safe = url.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    return (
        '<div style="position:relative;height:calc(100vh - 120px);min-height:520px">\n'
        '  <iframe src="%s" title="Zasoby domowe" allow="camera; clipboard-write" '
        'style="position:absolute;inset:0;width:100%%;height:100%%;border:0;border-radius:12px"></iframe>\n'
        "</div>\n" % safe
    )


class HomeManagerPlugin:
    def __init__(self):
        self.url = ""
        self.token = ""
        self.interval = 300
        self.elapsed = 0
        self.results = queue.Queue()
        self.busy = False
        self.debug = False

    # ----- Domoticz -----
    def onStart(self):
        self.debug = Parameters.get("Mode6") == "1"
        if self.debug:
            Domoticz.Debugging(1)
        self.url = Parameters["Address"].strip().rstrip("/")
        if "://" not in self.url:
            self.url = "http://" + self.url
        port = str(Parameters.get("Port") or "").strip()
        if port and port not in ("0", "80", "443") and self.url.count(":") < 2:
            self.url += ":" + port
        self.token = Parameters["Password"].strip()
        try:
            self.interval = max(60, int(float(Parameters.get("Mode1") or 5) * 60))
        except ValueError:
            self.interval = 300
        self.create_devices()
        self.write_page()
        Domoticz.Heartbeat(10)
        self.fetch()

    def onStop(self):
        pass

    def onHeartbeat(self):
        self.apply_results()
        self.elapsed += 10
        if self.elapsed >= self.interval:
            self.elapsed = 0
            self.fetch()

    # ----- Urządzenia -----
    def create_devices(self):
        for unit, (name, _key, label) in COUNTERS.items():
            if unit not in Devices:
                Domoticz.Device(Name=name, Unit=unit, Type=243, Subtype=31, Options={"Custom": "1;" + label}, Used=1).Create()
        if UNIT_ALERT not in Devices:
            Domoticz.Device(Name="Wymaga uwagi", Unit=UNIT_ALERT, Type=243, Subtype=22, Used=1).Create()
        if UNIT_SHOPPING not in Devices:
            Domoticz.Device(Name="Lista zakupów", Unit=UNIT_SHOPPING, Type=243, Subtype=19, Used=1).Create()
        if UNIT_TODAY not in Devices:
            Domoticz.Device(Name="Dziś w kalendarzu", Unit=UNIT_TODAY, Type=243, Subtype=19, Used=1).Create()

    def update(self, unit, n_value, s_value):
        dev = Devices.get(unit)
        if dev is None:
            return
        if dev.nValue != n_value or dev.sValue != s_value or getattr(dev, "TimedOut", 0):
            dev.Update(nValue=n_value, sValue=s_value, TimedOut=0)

    def apply_results(self):
        while not self.results.empty():
            ok, payload = self.results.get_nowait()
            if not ok:
                Domoticz.Error("Zasoby domowe: " + payload)
                for dev in Devices.values():
                    if not getattr(dev, "TimedOut", 0):
                        dev.Update(nValue=dev.nValue, sValue=dev.sValue, TimedOut=1)
                continue
            self.apply_summary(payload)

    def apply_summary(self, summary):
        s = summary["stats"]
        for unit, (_name, key, _label) in COUNTERS.items():
            value = s["warranty_ending"] + s["service_due"] if key is None else s[key]
            text = ("%.2f" % value) if isinstance(value, float) or unit in (10, 11) else str(value)
            self.update(unit, 0, text)
        level, text = describe(summary)
        self.update(UNIT_ALERT, level, text)
        self.update(UNIT_SHOPPING, 0, shopping_text(summary))
        self.update(UNIT_TODAY, 0, today_text(summary))
        Domoticz.Debug("Zasoby domowe: odświeżono")

    # ----- Pobieranie w tle (Domoticz nie lubi blokowania) -----
    def fetch(self):
        if self.busy:
            return
        self.busy = True
        threading.Thread(target=self._fetch_worker, name="HomeManagerFetch", daemon=True).start()

    def _fetch_worker(self):
        try:
            req = urllib.request.Request(
                self.url + "/api/integration/summary",
                headers={"Authorization": "Bearer " + self.token, "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                self.results.put((True, json.loads(resp.read().decode("utf-8"))))
        except urllib.error.HTTPError as err:
            msg = "nieprawidłowy klucz API" if err.code == 401 else "błąd serwera %d" % err.code
            self.results.put((False, msg))
        except Exception as err:  # brak sieci, zły adres, nieprawidłowa odpowiedź
            self.results.put((False, "brak połączenia z %s (%s)" % (self.url, err)))
        finally:
            self.busy = False

    # ----- Strona w menu Custom -----
    def write_page(self):
        folder = os.path.join(Parameters.get("StartupFolder", ""), "www", "templates")
        path = os.path.join(folder, PAGE_NAME)
        try:
            if Parameters.get("Mode2", "1") == "1":
                os.makedirs(folder, exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(page_html((Parameters.get("Mode3") or "").strip() or self.url))
            elif os.path.exists(path):
                os.remove(path)
        except OSError as err:
            Domoticz.Error("Zasoby domowe: nie udało się zapisać strony w menu Custom (%s)" % err)


_plugin = HomeManagerPlugin()


def onStart():
    _plugin.onStart()


def onStop():
    _plugin.onStop()


def onHeartbeat():
    _plugin.onHeartbeat()
