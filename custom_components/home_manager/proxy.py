"""Aplikacja Zasoby domowe przez Home Assistant – działa wszędzie tam, gdzie działa HA.

Panel w menu prosi (przez połączenie websocket – tylko zalogowani użytkownicy HA) o krótkotrwały
klucz sesji panelu, zapisuje go w ciasteczku ograniczonym do ścieżki /api/home_manager/proxy/<wpis>/
i otwiera tam aplikację. Widok poniżej przekazuje żądania do serwera aplikacji.
Dzięki temu nie trzeba wystawiać aplikacji osobno (np. przez Nginx Proxy Manager) – telefon poza domem
łączy się tylko z Home Assistant.
"""

from __future__ import annotations

import secrets
import time

from aiohttp import ClientError, ClientTimeout, web
import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN

COOKIE = "hm_panel"
SESSION_SECONDS = 24 * 3600
PROXY_PREFIX = "/api/home_manager/proxy"
DATA_SESSIONS = f"{DOMAIN}_panel_sessions"

# Nagłówki przekazywane do aplikacji i z powrotem (bez ciasteczek HA – nie mogą wyjść poza HA).
REQUEST_HEADERS = ("accept", "accept-language", "authorization", "content-type", "range")
RESPONSE_HEADERS = (
    "content-type", "cache-control", "content-disposition", "content-security-policy",
    "x-content-type-options", "content-range", "accept-ranges",
)


def proxy_path(entry_id: str) -> str:
    return f"{PROXY_PREFIX}/{entry_id}/"


def _sessions(hass: HomeAssistant) -> dict[str, tuple[str, float]]:
    return hass.data.setdefault(DATA_SESSIONS, {})


@callback
def new_session(hass: HomeAssistant, entry_id: str) -> str:
    sessions = _sessions(hass)
    now = time.monotonic()
    for token, (_, expires) in list(sessions.items()):
        if expires < now:
            del sessions[token]
    token = secrets.token_urlsafe(32)
    sessions[token] = (entry_id, now + SESSION_SECONDS)
    return token


def _valid(hass: HomeAssistant, token: str | None, entry_id: str) -> bool:
    if not token:
        return False
    found = _sessions(hass).get(token)
    return bool(found and found[0] == entry_id and found[1] > time.monotonic())


@websocket_api.websocket_command({vol.Required("type"): "home_manager/panel", vol.Required("entry_id"): str})
@callback
def ws_panel(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Klucz sesji panelu dla zalogowanego użytkownika HA."""
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Nie znaleziono integracji Zasoby domowe")
        return
    connection.send_result(
        msg["id"],
        {"token": new_session(hass, entry.entry_id), "cookie": COOKIE, "path": proxy_path(entry.entry_id), "max_age": SESSION_SECONDS},
    )


class HomeManagerProxyView(HomeAssistantView):
    """Przekazuje żądania z panelu do serwera aplikacji."""

    url = PROXY_PREFIX + "/{entry_id}/{path:.*}"
    name = "api:home_manager:proxy"
    requires_auth = False  # sprawdzamy własne ciasteczko sesji panelu (ramka nie wysyła tokenu HA)

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def _handle(self, request: web.Request, entry_id: str, path: str) -> web.StreamResponse:
        if not _valid(self.hass, request.cookies.get(COOKIE), entry_id):
            return web.Response(
                status=401, content_type="text/html", charset="utf-8",
                text="<p style='font-family:sans-serif;padding:24px'>Sesja panelu wygasła. "
                     "Otwórz ponownie „Zasoby domowe” z menu Home Assistant.</p>",
            )
        entry = self.hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN or not hasattr(entry, "runtime_data"):
            return web.Response(status=404, text="Integracja Zasoby domowe nie jest uruchomiona")
        client = entry.runtime_data.client
        session = async_get_clientsession(self.hass, verify_ssl=entry.data.get("verify_ssl", True))
        target = f"{client.url}/{path}"
        if request.query_string:
            target += f"?{request.query_string}"
        headers = {k: v for k, v in request.headers.items() if k.lower() in REQUEST_HEADERS}
        headers["X-Forwarded-For"] = request.remote or ""
        body = await request.read() if request.method in ("POST", "PUT", "PATCH") else None
        try:
            async with session.request(request.method, target, headers=headers, data=body, allow_redirects=False, timeout=ClientTimeout(total=60)) as resp:
                payload = await resp.read()
                out = {k: v for k, v in resp.headers.items() if k.lower() in RESPONSE_HEADERS}
                return web.Response(status=resp.status, body=payload, headers=out)
        except (ClientError, TimeoutError) as err:
            return web.Response(
                status=502, content_type="text/html", charset="utf-8",
                text=f"<p style='font-family:sans-serif;padding:24px'>Home Assistant nie może połączyć się z aplikacją "
                     f"Zasoby domowe ({client.url}): {err}</p>",
            )

    get = post = put = patch = delete = head = _handle


@callback
def async_setup_proxy(hass: HomeAssistant) -> None:
    hass.http.register_view(HomeManagerProxyView(hass))
    websocket_api.async_register_command(hass, ws_panel)

