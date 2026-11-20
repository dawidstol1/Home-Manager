"""Testy wtyczki na prawdziwym Home Assistant i prawdziwym serwerze aplikacji (Node + PostgreSQL)."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

SERVER = Path(__file__).with_name("server.js")


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Pozwala ładować custom_components/home_manager."""
    yield


@pytest.fixture
def hm_server(socket_enabled):
    """Uruchamia serwer aplikacji z danymi przykładowymi; zwraca adres i klucz API."""
    proc = subprocess.Popen(["node", str(SERVER)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = proc.stdout.readline()
    if not line:
        proc.kill()
        raise RuntimeError(f"Serwer testowy nie wystartował: {proc.stderr.read()}")
    info = json.loads(line)
    yield info
    proc.terminate()
    proc.wait(timeout=10)
