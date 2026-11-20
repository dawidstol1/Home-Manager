"""Czujniki: zakupy, terminy, apteczka, wydatki, kalendarz."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorEntityDescription, SensorStateClass
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import HomeManagerConfigEntry
from .dynamic import RowEntity, medicine_icon, track_rows
from .entity import HomeManagerEntity


@dataclass(frozen=True, kw_only=True)
class HMSensorDescription(SensorEntityDescription):
    value: Callable[[dict], Any]
    attrs: Callable[[dict], dict] = lambda d: {}


def _names(items: list[dict]) -> list[str]:
    return [i["name"] for i in items]


SENSORS: tuple[HMSensorDescription, ...] = (
    HMSensorDescription(
        key="shopping", translation_key="shopping", icon="mdi:cart-outline", native_unit_of_measurement="poz.",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["stats"]["low_stock"],
        attrs=lambda d: {"items": [f"{i['name']}: {i['to_buy']:g} {i['unit']}" for i in d["shopping"]]},
    ),
    HMSensorDescription(
        key="expired", translation_key="expired", icon="mdi:calendar-remove", native_unit_of_measurement="poz.",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["stats"]["expired"], attrs=lambda d: {"items": _names(d["expired_items"])},
    ),
    HMSensorDescription(
        key="expiring", translation_key="expiring", icon="mdi:calendar-clock", native_unit_of_measurement="poz.",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: len(d["expiring_items"]),
        attrs=lambda d: {"items": [f"{i['name']} ({i['expires_at']})" for i in d["expiring_items"]]},
    ),
    HMSensorDescription(
        key="total_items", translation_key="total_items", icon="mdi:package-variant-closed", native_unit_of_measurement="poz.",
        state_class=SensorStateClass.MEASUREMENT, value=lambda d: d["stats"]["total_items"],
    ),
    HMSensorDescription(
        key="medicines", translation_key="medicines", icon="mdi:pill", native_unit_of_measurement="leki",
        state_class=SensorStateClass.MEASUREMENT, value=lambda d: d["stats"]["medicines"],
    ),
    HMSensorDescription(
        key="med_expired", translation_key="med_expired", icon="mdi:pill-off", native_unit_of_measurement="leki",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["stats"]["med_expired"], attrs=lambda d: {"medicines": _names(d["medicines"]["expired"])},
    ),
    HMSensorDescription(
        key="med_expiring", translation_key="med_expiring", icon="mdi:pill", native_unit_of_measurement="leki",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["stats"]["med_expiring"],
        attrs=lambda d: {"medicines": [f"{m['name']} ({m['deadline']})" for m in d["medicines"]["expiring"]]},
    ),
    HMSensorDescription(
        key="med_low", translation_key="med_low", icon="mdi:pill-multiple", native_unit_of_measurement="leki",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["stats"]["med_low"], attrs=lambda d: {"medicines": _names(d["medicines"]["low"])},
    ),
    HMSensorDescription(
        key="equipment", translation_key="equipment", icon="mdi:wrench-clock", native_unit_of_measurement="szt.",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["stats"]["warranty_ending"] + d["stats"]["service_due"],
        attrs=lambda d: {"warranty_ending": d["stats"]["warranty_ending"], "service_due": d["stats"]["service_due"]},
    ),
    HMSensorDescription(
        key="spent_month", translation_key="spent_month", device_class=SensorDeviceClass.MONETARY,
        native_unit_of_measurement="PLN", suggested_display_precision=2, value=lambda d: d["stats"]["spent_month"],
    ),
    HMSensorDescription(
        key="wasted_month", translation_key="wasted_month", device_class=SensorDeviceClass.MONETARY,
        native_unit_of_measurement="PLN", suggested_display_precision=2, value=lambda d: d["stats"]["wasted_month"],
    ),
    HMSensorDescription(
        key="events_today", translation_key="events_today", icon="mdi:calendar-today", native_unit_of_measurement="wpisy",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["stats"]["events_today"],
        attrs=lambda d: {"events": [f"{e['start_time'] + ' ' if e['start_time'] else ''}{e['title']}" for e in d["events_today"]]},
    ),
)


async def async_setup_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities(HomeManagerSensor(entry, d) for d in SENSORS)
    track_rows(
        entry,
        async_add_entities,
        {
            "items": lambda row: [ItemSensor(entry, row)],
            "medicines": lambda row: [MedicineSensor(entry, row)],
        },
    )


class HomeManagerSensor(HomeManagerEntity, SensorEntity):
    entity_description: HMSensorDescription

    def __init__(self, entry: HomeManagerConfigEntry, description: HMSensorDescription) -> None:
        super().__init__(entry, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> Any:
        return self.entity_description.value(self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict:
        return self.entity_description.attrs(self.coordinator.data)


class ItemSensor(RowEntity, SensorEntity):
    """Ilość produktu (np. „Mleko: 2 l”) z terminem, miejscem i zdjęciem."""

    kind = "items"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:package-variant"

    def __init__(self, entry: HomeManagerConfigEntry, row: dict) -> None:
        super().__init__(entry, row, "quantity")
        self._attr_name = row["name"]

    @property
    def native_value(self):
        return self.row["quantity"] if self.row else None

    @property
    def native_unit_of_measurement(self) -> str | None:
        return self.row["unit"] if self.row else None

    @property
    def entity_picture(self) -> str | None:
        r = self.row
        if r and r.get("image"):
            return f"{self.entry.runtime_data.client.url}/images/{r['image']}"
        return None

    @property
    def extra_state_attributes(self) -> dict:
        r = self.row or {}
        low = r.get("min_quantity", 0) > 0 and r.get("quantity", 0) <= r.get("min_quantity", 0)
        return {
            "item_id": r.get("id"),
            "category": r.get("category"),
            "location": r.get("location"),
            "expires_at": r.get("expires_at"),
            "min_quantity": r.get("min_quantity"),
            "low": low,
            "batches": r.get("batch_count"),
            "barcode": r.get("barcode"),
            "price": r.get("price"),
        }


class MedicineSensor(RowEntity, SensorEntity):
    """Ilość leku z terminem, dawkowaniem i ostatnim podaniem."""

    kind = "medicines"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, entry: HomeManagerConfigEntry, row: dict) -> None:
        super().__init__(entry, row, "quantity")
        self._attr_name = row["name"]

    @property
    def icon(self) -> str:
        return medicine_icon((self.row or {}).get("form", ""))

    @property
    def native_value(self):
        return self.row["quantity"] if self.row else None

    @property
    def native_unit_of_measurement(self) -> str | None:
        return self.row["unit"] if self.row else None

    @property
    def extra_state_attributes(self) -> dict:
        r = self.row or {}
        last = r.get("last_taken") or {}
        return {
            "medicine_id": r.get("id"),
            "substance": r.get("substance"),
            "strength": r.get("strength"),
            "form": r.get("form"),
            "purpose": r.get("purpose"),
            "person": r.get("person"),
            "kit": r.get("kit"),
            "dosage": r.get("dosage"),
            "prescription": r.get("prescription"),
            "next_deadline": r.get("next_deadline"),
            "has_expired_packs": r.get("has_expired"),
            "expiring": r.get("expiring"),
            "low": r.get("low"),
            "opened": r.get("opened"),
            "last_taken": last.get("created_at"),
            "last_taken_person": last.get("person"),
            "last_taken_amount": last.get("amount"),
        }
