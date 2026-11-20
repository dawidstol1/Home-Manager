"""Akcje Home Assistant: zużycie, dodawanie, wyszukiwanie produktów i leków, podanie leku."""

from __future__ import annotations

from datetime import date

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .api import HomeManagerError
from .const import DOMAIN
from .coordinator import HomeManagerData
from .matching import best, key, person as match_person

ATTR_ENTRY = "config_entry_id"
ENTRY = {vol.Optional(ATTR_ENTRY): cv.string}


def runtime(hass: HomeAssistant, entry_id: str | None = None) -> HomeManagerData:
    entries = list(hass.config_entries.async_loaded_entries(DOMAIN))
    if entry_id:
        entries = [e for e in entries if e.entry_id == entry_id]
    if not entries:
        raise ServiceValidationError("Brak skonfigurowanej integracji Zasoby domowe")
    return entries[0].runtime_data


async def find_item(data: HomeManagerData, query: str) -> dict:
    rows = data.coordinator.data.get("all_items") or await data.client.items()
    found = best(query, rows)
    if not found:
        rows = await data.client.items()  # może dodano przed chwilą
        found = best(query, rows)
    if not found:
        raise ServiceValidationError(f"Nie znaleziono produktu „{query}”")
    # Przy kilku pasujących – ten, który jest na stanie i ma najkrótszy termin.
    found.sort(key=lambda r: (r["quantity"] <= 0, r.get("expires_at") or "9999"))
    return found[0]


async def find_medicine(data: HomeManagerData, query: str) -> dict:
    rows = data.coordinator.data.get("all_medicines") or await data.client.medicines()
    found = best(query, rows) or best(query, rows, "substance")
    if not found:
        rows = await data.client.medicines()
        found = best(query, rows) or best(query, rows, "substance")
    if not found:
        raise ServiceValidationError(f"Nie znaleziono leku „{query}” w apteczce")
    found.sort(key=lambda r: (r["quantity"] <= 0,))
    return found[0]


def medicines_for(rows: list[dict], symptom: str) -> list[dict]:
    """Leki „na co” pasujące do objawu (i niepuste, nie po terminie)."""
    out = []
    for r in rows:
        purposes = [p.strip() for p in (r.get("purpose") or "").replace(";", ",").split(",") if p.strip()]
        if any(best(symptom, [{"name": p}]) for p in purposes) and r["quantity"] > 0:
            out.append(r)
    return out


def item_view(r: dict) -> dict:
    return {
        "id": r["id"], "name": r["name"], "quantity": r["quantity"], "unit": r["unit"],
        "location": r.get("location"), "category": r.get("category"), "expires_at": r.get("expires_at"),
        "low": r.get("min_quantity", 0) > 0 and r["quantity"] <= r.get("min_quantity", 0),
    }


def medicine_view(r: dict) -> dict:
    last = r.get("last_taken") or {}
    return {
        "id": r["id"], "name": r["name"], "quantity": r["quantity"], "unit": r["unit"], "form": r.get("form"),
        "strength": r.get("strength"), "purpose": r.get("purpose"), "person": r.get("person"), "kit": r.get("kit"),
        "dosage": r.get("dosage"), "next_deadline": r.get("next_deadline"), "has_expired_packs": r.get("has_expired"),
        "last_taken": last.get("created_at"), "last_taken_person": last.get("person"),
    }


async def known_persons(data: HomeManagerData) -> list[str]:
    names = {r.get("person") for r in data.coordinator.data.get("all_medicines", []) if r.get("person")}
    try:
        names |= {u["name"] for u in await data.client.users()}
    except HomeManagerError:
        pass
    return sorted(n for n in names if n)


def _wrap(fn):
    async def handler(call: ServiceCall) -> ServiceResponse:
        data = runtime(call.hass, call.data.get(ATTR_ENTRY))
        try:
            result = await fn(call, data)
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        await data.coordinator.async_request_refresh()
        return result

    return handler


async def _consume(call: ServiceCall, data: HomeManagerData) -> ServiceResponse:
    result = await data.client.consume(call.data["barcode"], call.data["reason"])
    item = result.get("item", {})
    return {"name": item.get("name"), "quantity": item.get("quantity"), "unit": item.get("unit")}


async def _take(call: ServiceCall, data: HomeManagerData) -> ServiceResponse:
    med = await find_medicine(data, str(call.data["medicine"]))
    who = call.data.get("person", "")
    if who:
        who = match_person(who, await known_persons(data))
    result = await data.client.take_medicine(med["id"], call.data["amount"], who, call.data.get("note", ""))
    return {"name": result["name"], "left": result["quantity"], "unit": result["unit"], "person": who}


async def _adjust(call: ServiceCall, data: HomeManagerData) -> ServiceResponse:
    item = await find_item(data, str(call.data["item"]))
    amount = call.data["amount"]
    mode = call.data["mode"]
    if mode == "add":
        result = await data.client.adjust_item(item["id"], amount)
    else:
        if item["quantity"] <= 0:
            raise ServiceValidationError(f"„{item['name']}” – brak na stanie")
        result = await data.client.adjust_item(item["id"], -min(amount, item["quantity"]), mode)
    return {"name": result["name"], "quantity": result["quantity"], "unit": result["unit"]}


async def _find_items(call: ServiceCall, data: HomeManagerData) -> ServiceResponse:
    rows = await data.client.items(status=call.data.get("status") or None)
    if q := call.data.get("query"):
        rows = best(q, rows) or [r for r in rows if key(q) in key(r["name"])]
    return {"items": [item_view(r) for r in rows]}


async def _find_medicines(call: ServiceCall, data: HomeManagerData) -> ServiceResponse:
    rows = await data.client.medicines()
    q = call.data.get("query")
    if q:
        by_name = best(q, rows) or best(q, rows, "substance")
        rows = by_name or medicines_for(rows, q)
    return {"medicines": [medicine_view(r) for r in rows]}


async def _add_item(call: ServiceCall, data: HomeManagerData) -> ServiceResponse:
    body = {k: call.data[k] for k in ("name", "quantity", "unit", "min_quantity", "barcode", "notes") if k in call.data}
    if isinstance(call.data.get("expires_at"), date):
        body["expires_at"] = call.data["expires_at"].isoformat()
    for field, kind in (("category", "categories"), ("location", "locations")):
        if call.data.get(field):
            match = best(call.data[field], await data.client.dictionary(kind))
            if not match:
                raise ServiceValidationError(f"Nie ma takiej {'kategorii' if field == 'category' else 'lokalizacji'}: „{call.data[field]}”")
            body[f"{field}_id"] = match[0]["id"]
    item = await data.client.create_item(body)
    return item_view(item)


async def _add_pack(call: ServiceCall, data: HomeManagerData) -> ServiceResponse:
    med = await find_medicine(data, str(call.data["medicine"]))
    exp = call.data.get("expires_at")
    result = await data.client.add_medicine_pack(med["id"], call.data["quantity"], exp.isoformat() if isinstance(exp, date) else None)
    return {"name": result["name"], "quantity": result["quantity"], "unit": result["unit"]}


def register(hass: HomeAssistant) -> None:
    amount = vol.All(vol.Coerce(float), vol.Range(min=0.001, max=100000))
    specs = {
        "consume_barcode": (_consume, {vol.Required("barcode"): cv.string, vol.Optional("reason", default="used"): vol.In(["used", "wasted"])}),
        "take_medicine": (_take, {
            vol.Required("medicine"): cv.string, vol.Optional("amount", default=1): amount,
            vol.Optional("person", default=""): cv.string, vol.Optional("note", default=""): cv.string,
        }),
        "adjust_item": (_adjust, {
            vol.Required("item"): cv.string, vol.Optional("amount", default=1): amount,
            vol.Optional("mode", default="used"): vol.In(["used", "wasted", "add"]),
        }),
        "find_items": (_find_items, {vol.Optional("query"): cv.string, vol.Optional("status"): vol.In(["", "low", "expiring", "expired"])}),
        "find_medicines": (_find_medicines, {vol.Optional("query"): cv.string}),
        "add_item": (_add_item, {
            vol.Required("name"): cv.string, vol.Optional("quantity", default=1): vol.Coerce(float),
            vol.Optional("unit", default="szt."): cv.string, vol.Optional("min_quantity", default=0): vol.Coerce(float),
            vol.Optional("category"): cv.string, vol.Optional("location"): cv.string, vol.Optional("expires_at"): cv.date,
            vol.Optional("barcode"): cv.string, vol.Optional("notes"): cv.string,
        }),
        "add_medicine_pack": (_add_pack, {vol.Required("medicine"): cv.string, vol.Required("quantity"): amount, vol.Optional("expires_at"): cv.date}),
    }
    for name, (fn, schema) in specs.items():
        hass.services.async_register(
            DOMAIN, name, _wrap(fn), schema=vol.Schema({**schema, **ENTRY}),
            supports_response=SupportsResponse.ONLY if name.startswith("find_") else SupportsResponse.OPTIONAL,
        )
