"""„Coś wymaga uwagi” – do automatyzacji i powiadomień."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import HomeManagerConfigEntry
from .entity import HomeManagerEntity


async def async_setup_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([AttentionSensor(entry)])


def problems(d: dict) -> list[str]:
    """Krótkie opisy rzeczy, które wymagają uwagi."""
    out = []
    s = d["stats"]
    if s["expired"]:
        out.append(f"Po terminie: {', '.join(i['name'] for i in d['expired_items'][:5])}")
    if s["med_expired"]:
        out.append(f"Leki po terminie: {', '.join(m['name'] for m in d['medicines']['expired'][:5])}")
    if s["low_stock"]:
        out.append(f"Do kupienia: {s['low_stock']}")
    if s["service_due"]:
        out.append(f"Przeglądy do zrobienia: {s['service_due']}")
    return out


class AttentionSensor(HomeManagerEntity, BinarySensorEntity):
    _attr_translation_key = "attention"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, entry: HomeManagerConfigEntry) -> None:
        super().__init__(entry, "attention")

    @property
    def is_on(self) -> bool:
        s = self.coordinator.data["stats"]
        return bool(s["expired"] or s["med_expired"] or s["service_due"])

    @property
    def extra_state_attributes(self) -> dict:
        return {"problems": problems(self.coordinator.data)}
