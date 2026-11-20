"""Konfiguracja, czujniki, kalendarz, lista zakupów, akcje i panel w menu."""

from __future__ import annotations

from datetime import timedelta
from homeassistant import config_entries
from homeassistant.components.calendar import DOMAIN as CAL_DOMAIN
from homeassistant.components.frontend import DATA_PANELS
from homeassistant.components.todo import DOMAIN as TODO_DOMAIN
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_manager.const import CONF_PANEL_URL, CONF_SHOW_PANEL, CONF_TOKEN, DOMAIN


async def _setup(hass: HomeAssistant, info: dict, **options) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Zasoby domowe",
        unique_id=info["url"],
        data={CONF_URL: info["url"], CONF_TOKEN: info["token"], CONF_VERIFY_SSL: True},
        options={CONF_SHOW_PANEL: True, CONF_PANEL_URL: "", **options},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_config_flow(hass: HomeAssistant, hm_server) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM

    bad = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: hm_server["url"], CONF_TOKEN: "hm_zly", CONF_VERIFY_SSL: True}
    )
    assert bad["errors"] == {CONF_TOKEN: "invalid_auth"}

    down = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: "http://127.0.0.1:9", CONF_TOKEN: hm_server["token"], CONF_VERIFY_SSL: True}
    )
    assert down["errors"] == {CONF_URL: "cannot_connect"}

    ok = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: hm_server["url"] + "/", CONF_TOKEN: hm_server["token"], CONF_VERIFY_SSL: True}
    )
    await hass.async_block_till_done()
    assert ok["type"] is FlowResultType.CREATE_ENTRY
    assert ok["title"] == "Zasoby domowe (Dawid)"
    assert ok["data"][CONF_URL] == hm_server["url"]


async def test_sensors_and_panel(hass: HomeAssistant, hm_server) -> None:
    entry = await _setup(hass, hm_server)
    panel = hass.data[DATA_PANELS]["home-manager"]
    assert panel.component_name == "iframe"
    assert panel.config == {"url": hm_server["url"]}
    assert panel.sidebar_title == "Zasoby domowe"
    assert panel.require_admin is False

    shopping = hass.states.get("sensor.zasoby_domowe_to_buy")
    assert shopping.state == "1"
    assert shopping.attributes["items"] == ["Mleko: 5 l"]
    assert hass.states.get("sensor.zasoby_domowe_expired_products").attributes["items"] == ["Ser"]
    assert hass.states.get("sensor.zasoby_domowe_expired_medicines").state == "1"
    assert hass.states.get("sensor.zasoby_domowe_medicines").state == "3"
    assert hass.states.get("sensor.zasoby_domowe_warranties_and_service").state == "1"
    assert hass.states.get("sensor.zasoby_domowe_calendar_entries_today").attributes["events"] == ["23:00 Dentysta"]
    attention = hass.states.get("binary_sensor.zasoby_domowe_needs_attention")
    assert attention.state == "on"
    assert "Leki po terminie: Stary syrop" in attention.attributes["problems"]

    # Wyłączenie wpisu zdejmuje panel z menu.
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert "home-manager" not in hass.data[DATA_PANELS]


async def test_panel_url_option(hass: HomeAssistant, hm_server) -> None:
    await _setup(hass, hm_server, panel_url="https://zasoby.example.pl")
    assert hass.data[DATA_PANELS]["home-manager"].config == {"url": "https://zasoby.example.pl"}


async def test_calendar(hass: HomeAssistant, hm_server) -> None:
    await _setup(hass, hm_server)
    cal = "calendar.zasoby_domowe_household_calendar"
    now = dt_util.now()
    resp = await hass.services.async_call(
        CAL_DOMAIN, "get_events",
        {"entity_id": cal, "start_date_time": now - timedelta(days=1), "end_date_time": now + timedelta(days=15)},
        blocking=True, return_response=True,
    )
    events = resp[cal]["events"]
    titles = [e["summary"] for e in events]
    assert "Dentysta" in titles
    assert titles.count("Wywóz śmieci") == 3  # jutro, +8 i +15 dni
    assert any(t.startswith("Koniec gwarancji: Pralka") for t in titles)
    dent = next(e for e in events if e["summary"] == "Dentysta")
    assert "T23:00:00" in dent["start"]
    assert "T23:30:00" in dent["end"]

    # Dodanie wpisu z Home Assistant.
    day = (now + timedelta(days=3)).date()
    await hass.services.async_call(
        CAL_DOMAIN, "create_event",
        {"entity_id": cal, "summary": "Wizyta u babci", "start_date": day.isoformat(), "end_date": (day + timedelta(days=1)).isoformat()},
        blocking=True,
    )
    resp = await hass.services.async_call(
        CAL_DOMAIN, "get_events",
        {"entity_id": cal, "start_date_time": now, "end_date_time": now + timedelta(days=5)},
        blocking=True, return_response=True,
    )
    assert any(e["summary"] == "Wizyta u babci" and e["start"] == day.isoformat() for e in resp[cal]["events"])


async def test_shopping_list_todo(hass: HomeAssistant, hm_server) -> None:
    await _setup(hass, hm_server)
    todo = "todo.zasoby_domowe_shopping_list"
    assert hass.states.get(todo).state == "1"
    items = await hass.services.async_call(TODO_DOMAIN, "get_items", {"entity_id": todo}, blocking=True, return_response=True)
    item = items[todo]["items"][0]
    assert item["summary"] == "Mleko – 5 l"
    await hass.services.async_call(TODO_DOMAIN, "update_item", {"entity_id": todo, "item": item["uid"], "status": "completed"}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(todo).state == "0"
    assert hass.states.get("sensor.zasoby_domowe_to_buy").state == "0"


async def test_services(hass: HomeAssistant, hm_server) -> None:
    await _setup(hass, hm_server)
    res = await hass.services.async_call(DOMAIN, "take_medicine", {"medicine": "paracetamol", "amount": 2, "person": "Zosia"}, blocking=True, return_response=True)
    assert res == {"name": "Paracetamol", "left": 18, "unit": "tabl.", "person": "Zosia"}
    res = await hass.services.async_call(DOMAIN, "consume_barcode", {"barcode": "5900820000011"}, blocking=True, return_response=True)
    assert res["name"] == "Mleko"
    assert res["quantity"] == 0
    with pytest.raises(Exception, match="Nie znaleziono leku"):
        await hass.services.async_call(DOMAIN, "take_medicine", {"medicine": "Nieistniejący"}, blocking=True)


async def test_invalid_key_starts_reauth(hass: HomeAssistant, hm_server) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=hm_server["url"],
        data={CONF_URL: hm_server["url"], CONF_TOKEN: "hm_usuniety", CONF_VERIFY_SSL: True},
        options={CONF_SHOW_PANEL: False},
    )
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    assert entry.state is config_entries.ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress()
    assert any(f["context"]["source"] == "reauth" for f in flows)
