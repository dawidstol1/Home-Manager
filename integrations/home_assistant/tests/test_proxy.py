"""Aplikacja przez Home Assistant (pośrednik dla panelu) – działa wszędzie, gdzie działa HA."""

from __future__ import annotations

from homeassistant.const import CONF_URL, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_manager.const import CONF_SHOW_PANEL, CONF_TOKEN, DOMAIN


async def test_proxy(hass: HomeAssistant, hm_server, hass_client_no_auth, hass_ws_client) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=hm_server["url"],
        data={CONF_URL: hm_server["url"], CONF_TOKEN: hm_server["token"], CONF_VERIFY_SSL: True},
        options={CONF_SHOW_PANEL: True},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    base = f"/api/home_manager/proxy/{entry.entry_id}/"
    client = await hass_client_no_auth()

    # Bez sesji panelu – odmowa (adres jest publiczny jak całe HA, więc musi być chroniony).
    resp = await client.get(base)
    assert resp.status == 401

    # Panel (zalogowany użytkownik HA) dostaje klucz sesji przez websocket.
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "home_manager/panel", "entry_id": entry.entry_id})
    msg = await ws.receive_json()
    assert msg["success"], msg
    session = msg["result"]
    assert session["path"] == base
    cookies = {session["cookie"]: session["token"]}

    resp = await client.get(base, cookies=cookies)
    assert resp.status == 200
    html = await resp.text()
    assert "<title>Manager zasobów domowych</title>" in html
    assert "frame-ancestors 'self'" in resp.headers["Content-Security-Policy"]

    css = await client.get(base + "styles.css", cookies=cookies)
    assert css.status == 200 and css.headers["Content-Type"].startswith("text/css")

    # API aplikacji przez pośrednika: logowanie domownika i dane.
    status = await (await client.get(base + "api/auth/status", cookies=cookies)).json()
    assert status["user"] is None
    resp = await client.get(base + "api/items", cookies=cookies)
    assert resp.status == 401  # bez logowania w aplikacji
    resp = await client.get(base + "api/items", cookies=cookies, headers={"Authorization": f"Bearer {hm_server['token']}"})
    assert resp.status == 200
    assert any(i["name"] == "Mleko" for i in await resp.json())
    resp = await client.post(
        base + "api/items/1/adjust", cookies=cookies, json={"delta": 1},
        headers={"Authorization": f"Bearer {hm_server['token']}"},
    )
    assert resp.status == 200

    # Ciasteczka Home Assistant nie trafiają do aplikacji, a jej Set-Cookie nie wraca do HA.
    resp = await client.get(base + "api/auth/status", cookies={**cookies, "secret_ha": "x"})
    assert "Set-Cookie" not in resp.headers

    # Klucz innego wpisu / zły klucz – odmowa.
    bad = await client.get(base, cookies={session["cookie"]: "zly"})
    assert bad.status == 401

    js = await client.get("/home_manager_static/home-manager-panel.js")
    assert js.status == 200
    assert "customElements.define('home-manager-panel'" in await js.text()
