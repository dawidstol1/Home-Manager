"""Zasoby domowe (Home-Manager) – integracja z Home Assistant.

Czujniki stanu domu, kalendarz, lista zakupów jako lista zadań, akcje do automatyzacji
oraz cała aplikacja w bocznym menu Home Assistant (panel).
"""

from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.components import frontend
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL, Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady, HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import CannotConnect, HomeManagerClient, HomeManagerError, InvalidAuth
from .const import CONF_PANEL_URL, CONF_SHOW_PANEL, CONF_TOKEN, DOMAIN, PANEL_ICON, PANEL_TITLE
from .coordinator import HomeManagerConfigEntry, HomeManagerCoordinator, HomeManagerData

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.CALENDAR, Platform.SENSOR, Platform.TODO]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

SERVICE_CONSUME = "consume_barcode"
SERVICE_TAKE_MEDICINE = "take_medicine"
ATTR_ENTRY = "config_entry_id"


def _panel_path(hass: HomeAssistant, entry: HomeManagerConfigEntry) -> str:
    """Pierwszy wpis dostaje „home-manager”, kolejne – z dopiskiem."""
    entries = hass.config_entries.async_entries(DOMAIN)
    return "home-manager" if not entries or entries[0].entry_id == entry.entry_id else f"home-manager-{entry.entry_id[:6].lower()}"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Akcje (usługi) wspólne dla wszystkich wpisów."""

    def _client(call: ServiceCall) -> tuple[HomeManagerClient, HomeManagerCoordinator]:
        entries = [e for e in hass.config_entries.async_loaded_entries(DOMAIN)]
        wanted = call.data.get(ATTR_ENTRY)
        if wanted:
            entries = [e for e in entries if e.entry_id == wanted]
        if not entries:
            raise ServiceValidationError("Brak skonfigurowanej integracji Zasoby domowe")
        data: HomeManagerData = entries[0].runtime_data
        return data.client, data.coordinator

    async def consume(call: ServiceCall) -> ServiceResponse:
        client, coordinator = _client(call)
        try:
            result = await client.consume(call.data["barcode"], call.data.get("reason", "used"))
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        await coordinator.async_request_refresh()
        item = result.get("item", {})
        return {"name": item.get("name"), "quantity": item.get("quantity"), "unit": item.get("unit")}

    async def take_medicine(call: ServiceCall) -> ServiceResponse:
        client, coordinator = _client(call)
        query = str(call.data["medicine"]).strip()
        try:
            found = await client.medicines(query)
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        exact = [m for m in found if m["name"].lower() == query.lower() or str(m["id"]) == query]
        med = (exact or found or [None])[0]
        if med is None:
            raise ServiceValidationError(f"Nie znaleziono leku „{query}” w apteczce")
        try:
            result = await client.take_medicine(med["id"], call.data.get("amount", 1), call.data.get("person", ""), call.data.get("note", ""))
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        await coordinator.async_request_refresh()
        return {"name": result["name"], "left": result["quantity"], "unit": result["unit"]}

    hass.services.async_register(
        DOMAIN,
        SERVICE_CONSUME,
        consume,
        schema=vol.Schema(
            {
                vol.Required("barcode"): cv.string,
                vol.Optional("reason", default="used"): vol.In(["used", "wasted"]),
                vol.Optional(ATTR_ENTRY): cv.string,
            }
        ),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_TAKE_MEDICINE,
        take_medicine,
        schema=vol.Schema(
            {
                vol.Required("medicine"): cv.string,
                vol.Optional("amount", default=1): vol.All(vol.Coerce(float), vol.Range(min=0.01)),
                vol.Optional("person", default=""): cv.string,
                vol.Optional("note", default=""): cv.string,
                vol.Optional(ATTR_ENTRY): cv.string,
            }
        ),
        supports_response=SupportsResponse.OPTIONAL,
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry) -> bool:
    session = async_get_clientsession(hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, True))
    client = HomeManagerClient(session, entry.data[CONF_URL], entry.data[CONF_TOKEN])
    try:
        await client.me()
    except InvalidAuth as err:
        raise ConfigEntryAuthFailed(str(err)) from err
    except (CannotConnect, HomeManagerError) as err:
        raise ConfigEntryNotReady(f"Serwer Zasoby domowe nie odpowiada: {err}") from err

    coordinator = HomeManagerCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    panel_path = None
    if entry.options.get(CONF_SHOW_PANEL, True):
        panel_path = _panel_path(hass, entry)
        frontend.async_register_built_in_panel(
            hass,
            "iframe",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            frontend_url_path=panel_path,
            config={"url": entry.options.get(CONF_PANEL_URL) or entry.data[CONF_URL]},
            require_admin=False,
            update=True,
        )
    entry.runtime_data = HomeManagerData(client=client, coordinator=coordinator, panel_path=panel_path)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded and entry.runtime_data.panel_path:
        frontend.async_remove_panel(hass, entry.runtime_data.panel_path, warn_if_unknown=False)
    return unloaded
