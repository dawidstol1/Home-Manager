"""Kalendarz domowy w Home Assistant (zakładka Kalendarz, automatyzacje)."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
import re

from homeassistant.components.calendar import CalendarEntity, CalendarEntityFeature, CalendarEvent
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .api import HomeManagerError
from .coordinator import HomeManagerConfigEntry
from .entity import HomeManagerEntity

MAX_DAYS = 400
CATEGORY = {
    "family": "Rodzina", "home": "Dom", "health": "Zdrowie", "school": "Szkoła",
    "work": "Praca", "birthday": "Urodziny", "trip": "Wyjazd", "other": "Inne",
}
RRULE = {"DAILY": "daily", "WEEKLY": "weekly", "MONTHLY": "monthly", "YEARLY": "yearly"}


async def async_setup_entry(hass: HomeAssistant, entry: HomeManagerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([HomeManagerCalendar(entry)])


def _tz():
    return dt_util.get_default_time_zone()


def _at(day: str, hhmm: str | None) -> datetime:
    t = time.fromisoformat(hhmm) if hhmm else time(0, 0)
    return datetime.combine(date.fromisoformat(day), t, tzinfo=_tz())


def to_calendar_event(e: dict) -> CalendarEvent:
    """Wpis z API → CalendarEvent (dzień „do” w HA jest wyłączny)."""
    last = e.get("end_date") or e["date"]
    if not e.get("start_time"):
        start, end = date.fromisoformat(e["date"]), date.fromisoformat(last) + timedelta(days=1)
    else:
        start = _at(e["date"], e["start_time"])
        if e.get("end_time"):
            end = _at(last, e["end_time"])
        elif e.get("end_date"):
            end = _at(last, None) + timedelta(days=1)
        else:
            end = start + timedelta(hours=1)
        if end <= start:
            end = start + timedelta(hours=1)
    details = []
    if e.get("readonly"):
        details.append("Termin z domu (gwarancja, przegląd lub lek)")
    else:
        details.append(CATEGORY.get(e.get("category"), "Inne"))
        if e.get("visibility") == "private":
            details.append("prywatne")
        if e.get("owner_name"):
            details.append(f"dodał(a): {e['owner_name']}")
    if e.get("notes"):
        details.append(e["notes"])
    repeating = e.get("repeat") not in (None, "none")
    return CalendarEvent(
        start=start,
        end=end,
        summary=("🔒 " if e.get("visibility") == "private" else "") + e["title"],
        description=" · ".join(details),
        uid=str(e["id"]) if e.get("id") else None,
        recurrence_id=e["date"] if repeating else None,
    )


class HomeManagerCalendar(HomeManagerEntity, CalendarEntity):
    _attr_translation_key = "household"
    _attr_supported_features = CalendarEntityFeature.CREATE_EVENT | CalendarEntityFeature.DELETE_EVENT

    def __init__(self, entry: HomeManagerConfigEntry) -> None:
        super().__init__(entry, "calendar")
        self._client = entry.runtime_data.client

    @property
    def event(self) -> CalendarEvent | None:
        """Trwający albo najbliższy wpis (bez terminów z domu)."""
        d = self.coordinator.data
        now = dt_util.now()
        candidates = [to_calendar_event(e) for e in d.get("events_today", []) if not e.get("from_home")]
        if d.get("next_event"):
            candidates.append(to_calendar_event(d["next_event"]))
        upcoming = [ev for ev in candidates if ev.end_datetime_local > now]
        return min(upcoming, key=lambda ev: ev.start_datetime_local, default=None)

    async def async_get_events(self, hass: HomeAssistant, start_date: datetime, end_date: datetime) -> list[CalendarEvent]:
        first = dt_util.as_local(start_date).date()
        last = dt_util.as_local(end_date).date()
        out: list[CalendarEvent] = []
        seen: set[str] = set()
        while first <= last:
            chunk_end = min(last, first + timedelta(days=MAX_DAYS))
            try:
                rows = await self._client.events(first.isoformat(), chunk_end.isoformat())
            except HomeManagerError as err:
                raise HomeAssistantError(f"Nie udało się pobrać kalendarza: {err}") from err
            for e in rows:
                key = e.get("key") or f"{e.get('id')}-{e['date']}"
                if key not in seen:
                    seen.add(key)
                    out.append(to_calendar_event(e))
            first = chunk_end + timedelta(days=1)
        return out

    async def async_create_event(self, **kwargs) -> None:
        start = kwargs["dtstart"]
        end = kwargs.get("dtend")
        body: dict = {"title": kwargs["summary"], "notes": kwargs.get("description") or "", "category": "family"}
        if isinstance(start, datetime):
            start, end = dt_util.as_local(start), dt_util.as_local(end) if end else None
            body["starts_on"] = start.date().isoformat()
            body["start_time"] = start.strftime("%H:%M")
            if end:
                if end.date() != start.date():
                    body["ends_on"] = end.date().isoformat()
                body["end_time"] = end.strftime("%H:%M")
        else:
            body["starts_on"] = start.isoformat()
            if end and end - start > timedelta(days=1):
                body["ends_on"] = (end - timedelta(days=1)).isoformat()
        if kwargs.get("rrule"):
            body.update(parse_rrule(kwargs["rrule"]))
        try:
            await self._client.create_event(body)
        except HomeManagerError as err:
            raise HomeAssistantError(str(err)) from err
        await self.coordinator.async_request_refresh()

    async def async_delete_event(self, uid: str, recurrence_id: str | None = None, recurrence_range: str | None = None) -> None:
        if recurrence_id and not recurrence_range:
            raise HomeAssistantError("Pojedynczego powtórzenia nie da się usunąć – usuń cały wpis albo zmień go w aplikacji")
        try:
            await self._client.delete_event(int(uid))
        except (ValueError, HomeManagerError) as err:
            raise HomeAssistantError(f"Nie udało się usunąć wpisu: {err}") from err
        await self.coordinator.async_request_refresh()


def parse_rrule(rrule: str) -> dict:
    """FREQ=WEEKLY;INTERVAL=2;UNTIL=20270101 → powtarzanie obsługiwane przez aplikację."""
    parts = dict(p.split("=", 1) for p in rrule.upper().split(";") if "=" in p)
    freq = RRULE.get(parts.get("FREQ", ""))
    interval = int(parts.get("INTERVAL", "1") or 1)
    if freq == "weekly" and interval == 2:
        freq = "biweekly"
    elif not freq or interval != 1 or "COUNT" in parts or ("BYDAY" in parts and (freq != "weekly" or "," in parts["BYDAY"])):
        raise HomeAssistantError("Kalendarz domowy obsługuje: codziennie, co tydzień, co 2 tygodnie, co miesiąc, co rok (bez liczby powtórzeń)")
    out = {"repeat": freq}
    if until := parts.get("UNTIL"):
        m = re.match(r"(\d{4})(\d{2})(\d{2})", until)
        if m:
            out["repeat_until"] = f"{m[1]}-{m[2]}-{m[3]}"
    return out
