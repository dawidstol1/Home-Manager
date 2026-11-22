"""Encje tworzone dla każdego produktu i leku – pojawiają się same, gdy coś dodasz w aplikacji."""

from __future__ import annotations

from collections.abc import Callable

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_ITEM_ENTITIES, DOMAIN, MANUFACTURER
from .coordinator import HomeManagerConfigEntry, HomeManagerCoordinator

FORM_ICON = (
    (("syrop", "zawies", "płyn", "roztw"), "mdi:bottle-tonic-plus-outline"),
    (("krop",), "mdi:eyedropper"),
    (("maś", "krem", "żel"), "mdi:lotion-outline"),
    (("aerozol", "spray", "inhal"), "mdi:spray"),
    (("plast", "opatr", "banda"), "mdi:bandage"),
)


def medicine_icon(form: str) -> str:
    f = (form or "").lower()
    for words, icon in FORM_ICON:
        if any(w in f for w in words):
            return icon
    return "mdi:pill"


SUB_DEVICES = {"items": "Zasoby domowe – produkty", "medicines": "Zasoby domowe – apteka"}


def sub_device(entry: HomeManagerConfigEntry, kind: str) -> DeviceInfo:
    """Osobne urządzenia „Produkty” i „Apteka” (zakładane w __init__, tu tylko odwołanie)."""
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry.entry_id}_{kind}")},
        name=SUB_DEVICES[kind],
        manufacturer=MANUFACTURER,
        entry_type=DeviceEntryType.SERVICE,
    )


class RowEntity(CoordinatorEntity[HomeManagerCoordinator]):
    """Encja jednego produktu albo leku (wiersz z listy w danych koordynatora)."""

    _attr_has_entity_name = True
    kind = "items"

    def __init__(self, entry: HomeManagerConfigEntry, row: dict, suffix: str) -> None:
        super().__init__(entry.runtime_data.coordinator)
        self.row_id = row["id"]
        self.entry = entry
        self._attr_unique_id = f"{entry.entry_id}_{self.kind}_{row['id']}_{suffix}"
        self._attr_device_info = sub_device(entry, self.kind)

    @property
    def row(self) -> dict | None:
        key = "all_items" if self.kind == "items" else "all_medicines"
        return next((r for r in self.coordinator.data.get(key, []) if r["id"] == self.row_id), None)

    @property
    def available(self) -> bool:
        return super().available and self.row is not None


def track_rows(
    entry: HomeManagerConfigEntry,
    add: Callable[[list], None],
    factories: dict[str, Callable[[dict], list]],
) -> None:
    """Dodaje encje dla nowych produktów/leków po każdym odświeżeniu danych."""
    coordinator = entry.runtime_data.coordinator
    known: dict[str, set[int]] = {k: set() for k in factories}

    @callback
    def update() -> None:
        new = []
        for kind, factory in factories.items():
            if kind == "items" and not entry.options.get(CONF_ITEM_ENTITIES, True):
                continue
            rows = coordinator.data.get("all_items" if kind == "items" else "all_medicines", [])
            for row in rows:
                if row["id"] not in known[kind]:
                    known[kind].add(row["id"])
                    new.extend(factory(row))
        if new:
            add(new)

    update()
    entry.async_on_unload(coordinator.async_add_listener(update))
