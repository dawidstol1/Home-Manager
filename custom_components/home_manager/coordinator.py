"""Okresowe pobieranie podsumowania stanu domu."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import timedelta
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import CannotConnect, HomeManagerClient, HomeManagerError, InvalidAuth
from .const import CONF_SCAN_MINUTES, DEFAULT_SCAN_MINUTES, DOMAIN

_LOGGER = logging.getLogger(__name__)


@dataclass
class HomeManagerData:
    """Dane wpisu konfiguracji."""

    client: HomeManagerClient
    coordinator: "HomeManagerCoordinator"
    panel_path: str | None


type HomeManagerConfigEntry = ConfigEntry[HomeManagerData]


class HomeManagerCoordinator(DataUpdateCoordinator[dict]):
    """Co kilka minut pobiera /api/integration/summary."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: HomeManagerClient) -> None:
        minutes = entry.options.get(CONF_SCAN_MINUTES, DEFAULT_SCAN_MINUTES)
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=timedelta(minutes=minutes),
        )
        self.client = client

    async def _async_update_data(self) -> dict:
        try:
            summary, items, medicines = await asyncio.gather(
                self.client.summary(), self.client.items(), self.client.medicines()
            )
            return {**summary, "all_items": items, "all_medicines": medicines}
        except InvalidAuth as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except (CannotConnect, HomeManagerError) as err:
            raise UpdateFailed(f"Brak połączenia z serwerem Zasoby domowe: {err}") from err
