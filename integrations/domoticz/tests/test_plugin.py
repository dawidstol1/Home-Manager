"""Wtyczka Domoticz z podstawionym modułem Domoticz i prawdziwym serwerem aplikacji (Node + PostgreSQL)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import types

import pytest

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent / "HomeManager" / "plugin.py"
SERVER = HERE.parents[1] / "home_assistant" / "tests" / "server.js"


class FakeDevice:
    def __init__(self, Name, Unit, Type, Subtype, Options=None, Used=0):
        self.Name, self.Unit, self.Type, self.SubType, self.Options, self.Used = Name, Unit, Type, Subtype, Options or {}, Used
        self.nValue, self.sValue, self.TimedOut, self.updates = 0, "", 0, 0

    def Create(self):
        devices[self.Unit] = self

    def Update(self, nValue, sValue, TimedOut=0):
        self.nValue, self.sValue, self.TimedOut = nValue, sValue, TimedOut
        self.updates += 1


devices: dict = {}
log: list = []


def load_plugin(params):
    fake = types.ModuleType("Domoticz")
    fake.Device = FakeDevice
    fake.Heartbeat = lambda s: None
    fake.Debugging = lambda n: None
    fake.Debug = lambda m: log.append(("debug", m))
    fake.Error = lambda m: log.append(("error", m))
    fake.Log = lambda m: log.append(("log", m))
    sys.modules["Domoticz"] = fake
    spec = importlib.util.spec_from_file_location("hm_plugin", PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.Parameters = params
    mod.Devices = devices
    return mod


def wait_results(mod, timeout=10):
    end = time.time() + timeout
    while mod._plugin.busy or mod._plugin.results.empty():
        if time.time() > end:
            raise TimeoutError("brak odpowiedzi wtyczki")
        time.sleep(0.05)
    mod.onHeartbeat()


@pytest.fixture
def server():
    proc = subprocess.Popen(["node", str(SERVER)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    info = json.loads(proc.stdout.readline())
    yield info
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture(autouse=True)
def reset():
    devices.clear()
    log.clear()


def test_devices_and_values(server, tmp_path):
    mod = load_plugin({"Address": server["url"] + "/", "Password": server["token"], "Mode1": "5", "Mode2": "1", "Mode3": "", "Mode6": "0", "StartupFolder": str(tmp_path) + "/"})
    mod.onStart()
    assert set(devices) == set(range(1, 12)) | {20, 21, 22}
    assert devices[1].Options == {"Custom": "1;poz."}
    wait_results(mod)
    assert devices[1].sValue == "1"            # do kupienia: Mleko
    assert devices[2].sValue == "1"            # po terminie: Ser
    assert devices[4].sValue == "2"            # leki w apteczce
    assert devices[5].sValue == "1"            # leki po terminie
    assert devices[8].sValue == "1"            # gwarancja pralki
    assert devices[9].sValue == "1"            # dziś: Dentysta
    assert devices[10].sValue == "0.00"
    assert devices[20].nValue == 4
    assert "Po terminie: Ser" in devices[20].sValue and "Leki po terminie: Stary syrop" in devices[20].sValue
    assert devices[21].sValue == "Mleko – 5 l"  # min 3, jest 1 → dokup do zapasu
    assert devices[22].sValue == "23:00 Dentysta"

    # Drugie odświeżenie bez zmian nie aktualizuje urządzeń (bez zbędnych wpisów w logu Domoticza).
    before = {u: d.updates for u, d in devices.items()}
    mod._plugin.fetch()
    wait_results(mod)
    assert {u: d.updates for u, d in devices.items()} == before

    page = (tmp_path / "www" / "templates" / "ZasobyDomowe.html").read_text(encoding="utf-8")
    assert f'src="{server["url"]}"' in page


def test_bad_key_marks_devices_timed_out(server, tmp_path):
    mod = load_plugin({"Address": server["url"], "Password": "hm_zly", "Mode1": "5", "Mode2": "0", "Mode3": "", "Mode6": "0", "StartupFolder": str(tmp_path) + "/"})
    mod.onStart()
    wait_results(mod)
    assert any("nieprawidłowy klucz API" in m for kind, m in log if kind == "error")
    assert all(d.TimedOut == 1 for d in devices.values())
    assert not (tmp_path / "www" / "templates" / "ZasobyDomowe.html").exists()


def test_custom_panel_url(server, tmp_path):
    mod = load_plugin({"Address": server["url"], "Password": server["token"], "Mode1": "1", "Mode2": "1", "Mode3": "https://zasoby.example.pl", "Mode6": "0", "StartupFolder": str(tmp_path) + "/"})
    mod.onStart()
    wait_results(mod)
    page = (tmp_path / "www" / "templates" / "ZasobyDomowe.html").read_text(encoding="utf-8")
    assert 'src="https://zasoby.example.pl"' in page
    assert mod._plugin.interval == 60
