"""Przyciski na kartach: „Zużyj 1” przy produkcie i „Podaj dawkę” przy leku."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import HomeManagerError
from .coordinator import HomeManagerConfigEntry
from .dynamic import RowEntity, medicine_icon, track_rows


def default_dose(unit: str) -> float:
    """Typowa jedna dawka: 5 ml syropu, 1 tabletka/kapsułka/sztuka."""
    return 5 if (unit or "").lower() == "ml" else 1


async def async_setup_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    track_rows(
        entry,
        async_add_entities,
        {
            "items": lambda row: [ConsumeButton(entry, row)],
            "medicines": lambda row: [GiveButton(entry, row)],
        },
    )


class ConsumeButton(RowEntity, ButtonEntity):
    kind = "items"
    _attr_icon = "mdi:minus-circle-outline"

    def __init__(self, entry: HomeManagerConfigEntry, row: dict) -> None:
        super().__init__(entry, row, "consume")
        self._attr_name = f"{row['name']} – zużyj 1"

    async def async_press(self) -> None:
        r = self.row
        if not r or r["quantity"] <= 0:
            raise HomeAssistantError("Brak na stanie")
        try:
            await self.entry.runtime_data.client.adjust_item(r["id"], -min(1, r["quantity"]), "used")
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        await self.coordinator.async_request_refresh()


class GiveButton(RowEntity, ButtonEntity):
    kind = "medicines"

    def __init__(self, entry: HomeManagerConfigEntry, row: dict) -> None:
        super().__init__(entry, row, "give")
        self._attr_name = f"{row['name']} – podaj dawkę"

    @property
    def icon(self) -> str:
        return medicine_icon((self.row or {}).get("form", ""))

    async def async_press(self) -> None:
        r = self.row
        if not r:
            raise HomeAssistantError("Nie ma już tego leku w apteczce")
        try:
            await self.entry.runtime_data.client.take_medicine(r["id"], default_dose(r["unit"]), "", "Przycisk w Home Assistant")
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        await self.coordinator.async_request_refresh()
