"""Funkcje natywne: encje produktów i leków, przyciski, akcje, komendy głosowe."""

from __future__ import annotations

from homeassistant.const import CONF_URL, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from datetime import timedelta

from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_manager.const import CONF_ITEM_ENTITIES, CONF_SHOW_PANEL, CONF_TOKEN, CONF_VOICE, DOMAIN

DOMAIN_TO_SERVICE = DOMAIN


async def _setup(hass: HomeAssistant, info: dict, **options) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=info["url"],
        data={CONF_URL: info["url"], CONF_TOKEN: info["token"], CONF_VERIFY_SSL: True},
        options={CONF_SHOW_PANEL: False, CONF_ITEM_ENTITIES: True, CONF_VOICE: True, **options},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _refresh(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    await entry.runtime_data.coordinator.async_refresh()
    await hass.async_block_till_done()


async def test_item_and_medicine_entities(hass: HomeAssistant, hm_server) -> None:
    await _setup(hass, hm_server)
    milk = hass.states.get("sensor.zasoby_domowe_produkty_mleko")
    assert milk.state == "1"
    assert milk.attributes["unit_of_measurement"] == "l"
    assert milk.attributes["low"] is True
    assert milk.attributes["barcode"] == "5900820000011"
    para = hass.states.get("sensor.zasoby_domowe_apteka_paracetamol")
    assert para.state == "20"
    assert para.attributes["purpose"] == "ból, gorączka"
    syrup = hass.states.get("sensor.zasoby_domowe_apteka_ibuprom_dla_dzieci")
    assert syrup.attributes["icon"] == "mdi:bottle-tonic-plus-outline"


async def test_buttons(hass: HomeAssistant, hm_server) -> None:
    entry = await _setup(hass, hm_server)
    await hass.services.async_call("button", "press", {"entity_id": "button.zasoby_domowe_produkty_jogurt_naturalny_zuzyj_1"}, blocking=True)
    await hass.services.async_call("button", "press", {"entity_id": "button.zasoby_domowe_apteka_ibuprom_dla_dzieci_podaj_dawke"}, blocking=True)
    await _refresh(hass, entry)
    assert hass.states.get("sensor.zasoby_domowe_produkty_jogurt_naturalny").state == "1"
    syrup = hass.states.get("sensor.zasoby_domowe_apteka_ibuprom_dla_dzieci")
    assert syrup.state == "95"
    assert syrup.attributes["last_taken_amount"] == 5


async def test_items_option_off(hass: HomeAssistant, hm_server) -> None:
    await _setup(hass, hm_server, **{CONF_ITEM_ENTITIES: False})
    assert hass.states.get("sensor.zasoby_domowe_produkty_mleko") is None
    assert hass.states.get("sensor.zasoby_domowe_apteka_paracetamol") is not None


async def test_services(hass: HomeAssistant, hm_server) -> None:
    entry = await _setup(hass, hm_server)
    # odmiana: „mleka” → Mleko
    res = await hass.services.async_call(DOMAIN, "adjust_item", {"item": "mleka", "amount": 2, "mode": "add"}, blocking=True, return_response=True)
    assert res == {"name": "Mleko", "quantity": 3, "unit": "l"}
    res = await hass.services.async_call(DOMAIN, "adjust_item", {"item": "Jogurtu"}, blocking=True, return_response=True)
    assert res["quantity"] == 1

    res = await hass.services.async_call(DOMAIN, "find_items", {"status": "expired"}, blocking=True, return_response=True)
    assert [i["name"] for i in res["items"]] == ["Ser"]
    res = await hass.services.async_call(DOMAIN, "find_medicines", {"query": "gorączkę"}, blocking=True, return_response=True)
    assert sorted(m["name"] for m in res["medicines"]) == ["Ibuprom dla dzieci", "Paracetamol"]

    res = await hass.services.async_call(DOMAIN, "take_medicine", {"medicine": "ibupromu", "amount": 5, "person": "Zosi"}, blocking=True, return_response=True)
    assert res == {"name": "Ibuprom dla dzieci", "left": 95, "unit": "ml", "person": "Zosia"}

    res = await hass.services.async_call(DOMAIN, "add_medicine_pack", {"medicine": "paracetamol", "quantity": 10, "expires_at": "2028-01-31"}, blocking=True, return_response=True)
    assert res["quantity"] == 30

    res = await hass.services.async_call(
        DOMAIN, "add_item", {"name": "Masło", "quantity": 2, "unit": "szt.", "location": "kuchni", "category": "żywność", "expires_at": "2027-01-10"},
        blocking=True, return_response=True,
    )
    assert res["location"] == "Kuchnia" and res["category"] == "Żywność"
    await _refresh(hass, entry)
    assert hass.states.get("sensor.zasoby_domowe_produkty_maslo").state == "2"


async def _ask(hass: HomeAssistant, text: str) -> str:
    res = await hass.services.async_call("conversation", "process", {"text": text, "language": "pl"}, blocking=True, return_response=True)
    return res["response"]["speech"]["plain"]["speech"]


async def test_voice(hass: HomeAssistant, hm_server) -> None:
    hass.config.language = "pl"
    assert await async_setup_component(hass, "homeassistant", {})
    assert await async_setup_component(hass, "conversation", {})
    entry = await _setup(hass, hm_server)

    assert await _ask(hass, "ile mamy mleka") == "Mleko: 1 l, ważne do " + hass.states.get("sensor.zasoby_domowe_produkty_mleko").attributes["expires_at"] + "."
    answer = await _ask(hass, "co mamy na gorączkę")
    assert answer.startswith("Na gorączkę: ") and "Paracetamol (20 tabl." in answer and "Ibuprom dla dzieci (100 ml, Zosia, leży: Kuchnia)" in answer
    assert await _ask(hass, "podaj ibuprom dla Zosi") == "Zapisałem 5 ml Ibuprom dla dzieci dla Zosi. Zostało 95 ml."
    assert await _ask(hass, "podaj Zosi paracetamol") == "Zapisałem 1 tabl. Paracetamol dla Zosi. Zostało 19 tabl."
    assert await _ask(hass, "co jest do kupienia") == "Do kupienia: Mleko 5 l."
    assert await _ask(hass, "zużyj jogurt") == "Zużyto 1 szt. Jogurt naturalny. Zostało 1 szt."
    assert await _ask(hass, "wyrzuć jogurtu") == "Wyrzucono 1 szt. Jogurt naturalny. Zostało 0 szt."
    expired = await _ask(hass, "co jest po terminie")
    await _refresh(hass, entry)
    assert "produkty: Ser" in expired and "leki: Stary syrop" in expired
    # W dzienniku leków zapisała się pełna forma imienia.
    syrup = entry.runtime_data.coordinator.data["all_medicines"]
    assert any((m.get("last_taken") or {}).get("person") == "Zosia" for m in syrup)
    await hass.services.async_call(
        "calendar", "create_event",
        {"entity_id": "calendar.zasoby_domowe_kalendarz_domowy", "summary": "Niespodzianka", "start_date": dt_util.now().date().isoformat(),
         "end_date": (dt_util.now().date() + timedelta(days=1)).isoformat()},
        blocking=True,
    )
    await entry.runtime_data.client.request("POST", "/events", json={"title": "Prywatne", "starts_on": dt_util.now().date().isoformat(), "visibility": "private"})
    today = await _ask(hass, "co mamy dziś w kalendarzu")
    assert "Niespodzianka" in today and "Prywatne" not in today
    assert today.startswith("Dziś, ") and "o 23:00 Dentysta" in today
    assert "Wywóz śmieci" in await _ask(hass, "co mamy jutro")
    assert await _ask(hass, "ile mamy kawioru") == "Nie mam w zasobach nic o nazwie kawioru."
