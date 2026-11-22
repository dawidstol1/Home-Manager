"""Zasoby domowe (Home-Manager) – integracja z Home Assistant.

Czujniki stanu domu, kalendarz, lista zakupów jako lista zadań, akcje do automatyzacji
oraz cała aplikacja w bocznym menu Home Assistant (panel).
"""

from __future__ import annotations

import logging

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv, device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import CannotConnect, HomeManagerClient, HomeManagerError, InvalidAuth
from . import assist, proxy, services
from .const import CONF_PANEL_URL, CONF_PROXY, CONF_SHOW_PANEL, CONF_TOKEN, CONF_VOICE, DOMAIN, MANUFACTURER, PANEL_ICON, PANEL_TITLE, STATIC_URL
from .coordinator import HomeManagerConfigEntry, HomeManagerCoordinator, HomeManagerData
from .dynamic import SUB_DEVICES

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.BUTTON, Platform.CALENDAR, Platform.SENSOR, Platform.TODO]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


def _panel_path(hass: HomeAssistant, entry: HomeManagerConfigEntry) -> str:
    """Pierwszy wpis dostaje „home-manager”, kolejne – z dopiskiem."""
    entries = hass.config_entries.async_entries(DOMAIN)
    return "home-manager" if not entries or entries[0].entry_id == entry.entry_id else f"home-manager-{entry.entry_id[:6].lower()}"


def _register_devices(hass: HomeAssistant, entry: HomeManagerConfigEntry) -> None:
    """Urządzenie główne i podrzędne („produkty”, „apteka”) – powiązane przez via_device_id
    (stary parametr via_device w DeviceInfo nowsze wersje HA odrzucają)."""
    registry = dr.async_get(hass)
    main = registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.entry_id)},
        name="Zasoby domowe",
        manufacturer=MANUFACTURER,
        entry_type=dr.DeviceEntryType.SERVICE,
        configuration_url=entry.options.get(CONF_PANEL_URL) or entry.data[CONF_URL],
    )
    for kind, name in SUB_DEVICES.items():
        sub = registry.async_get_or_create(
            config_entry_id=entry.entry_id,
            identifiers={(DOMAIN, f"{entry.entry_id}_{kind}")},
            name=name,
            manufacturer=MANUFACTURER,
            entry_type=dr.DeviceEntryType.SERVICE,
        )
        if sub.via_device_id != main.id:
            registry.async_update_device(sub.id, via_device_id=main.id)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Akcje (usługi) wspólne dla wszystkich wpisów."""
    services.register(hass)
    proxy.async_setup_proxy(hass)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), cache_headers=False)]
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
        if entry.options.get(CONF_PROXY, True):
            # Przez Home Assistant: działa w domu i poza domem (NPM, Nabu Casa, aplikacja HA na telefonie).
            version = hass.data.get("integrations", {}).get(DOMAIN)
            await panel_custom.async_register_panel(
                hass,
                frontend_url_path=panel_path,
                webcomponent_name="home-manager-panel",
                sidebar_title=PANEL_TITLE,
                sidebar_icon=PANEL_ICON,
                module_url=f"{STATIC_URL}/home-manager-panel.js?v={getattr(version, 'version', '1')}",
                config={"entry_id": entry.entry_id},
                require_admin=False,
            )
        else:
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
    _register_devices(hass, entry)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    if entry.options.get(CONF_VOICE, True) and entry.entry_id == hass.config_entries.async_entries(DOMAIN)[0].entry_id:
        try:
            assist.async_register(hass, entry)
        except Exception:  # noqa: BLE001 – Asystent jest dodatkiem, reszta integracji ma działać
            _LOGGER.warning("Zasoby domowe: komendy głosowe wyłączone", exc_info=True)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded and entry.runtime_data.panel_path:
        frontend.async_remove_panel(hass, entry.runtime_data.panel_path, warn_if_unknown=False)
    return unloaded
