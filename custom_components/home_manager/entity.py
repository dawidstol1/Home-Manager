"""Wspólna baza encji."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_PANEL_URL, DOMAIN, MANUFACTURER
from .coordinator import HomeManagerConfigEntry, HomeManagerCoordinator


class HomeManagerEntity(CoordinatorEntity[HomeManagerCoordinator]):
    """Encja przypięta do jednego urządzenia „Zasoby domowe”."""

    _attr_has_entity_name = True

    def __init__(self, entry: HomeManagerConfigEntry, key: str) -> None:
        super().__init__(entry.runtime_data.coordinator)
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Zasoby domowe",
            manufacturer=MANUFACTURER,
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=entry.options.get(CONF_PANEL_URL) or entry.data["url"],
        )
