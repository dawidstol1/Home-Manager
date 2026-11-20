"""Lista zakupów jako lista zadań – odhaczenie = kupione (stan w aplikacji rośnie)."""

from __future__ import annotations

from homeassistant.components.todo import TodoItem, TodoItemStatus, TodoListEntity, TodoListEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import HomeManagerError
from .coordinator import HomeManagerConfigEntry
from .entity import HomeManagerEntity


async def async_setup_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([ShoppingList(entry)])


def _fmt(n: float) -> str:
    return f"{n:g}".replace(".", ",")


class ShoppingList(HomeManagerEntity, TodoListEntity):
    _attr_translation_key = "shopping_list"
    _attr_supported_features = TodoListEntityFeature.UPDATE_TODO_ITEM

    def __init__(self, entry: HomeManagerConfigEntry) -> None:
        super().__init__(entry, "shopping_list")
        self._client = entry.runtime_data.client

    @property
    def todo_items(self) -> list[TodoItem]:
        return [
            TodoItem(
                uid=str(i["id"]),
                summary=f"{i['name']} – {_fmt(i['to_buy'])} {i['unit']}",
                description=f"Jest {_fmt(i['quantity'])} {i['unit']}" + (f" · {i['location']}" if i.get("location") else ""),
                status=TodoItemStatus.NEEDS_ACTION,
            )
            for i in self.coordinator.data["shopping"]
        ]

    async def async_update_todo_item(self, item: TodoItem) -> None:
        if item.status != TodoItemStatus.COMPLETED:
            return
        wanted = next((i for i in self.coordinator.data["shopping"] if str(i["id"]) == item.uid), None)
        if wanted is None:
            raise HomeAssistantError("Tej pozycji nie ma już na liście zakupów")
        try:
            await self._client.buy_item(wanted["id"], wanted["to_buy"])
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        await self.coordinator.async_request_refresh()
