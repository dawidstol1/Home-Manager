"""Polskie komendy dla Asystenta Home Assistant (Assist).

„ile mamy mleka”, „co mamy na gorączkę”, „podaj ibuprom dla Zosi”, „co jest do kupienia”,
„co mamy dziś w kalendarzu”, „zużyj jogurt”, „wyrzuć ser”, „co jest po terminie”.
"""

from __future__ import annotations

from datetime import timedelta
import logging

from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

from .api import HomeManagerError
from .coordinator import HomeManagerConfigEntry
from .matching import best, key, person as match_person, word_match
from .services import find_item, find_medicine, known_persons, medicines_for

_LOGGER = logging.getLogger(__name__)

WEEKDAYS = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"]


def num(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def names(rows: list[dict], limit: int = 6) -> str:
    out = ", ".join(r["name"] for r in rows[:limit])
    return out + (f" i {len(rows) - limit} innych" if len(rows) > limit else "")


def end(text: str) -> str:
    """Kropka na końcu zdania (bez podwajania po „tabl.”)."""
    return text if text.endswith(".") else text + "."


def _slot(result, name: str) -> str:
    ent = result.entities.get(name)
    return str(ent.value).strip() if ent else ""


class Assist:
    def __init__(self, hass: HomeAssistant, entry: HomeManagerConfigEntry) -> None:
        self.hass = hass
        self.entry = entry

    @property
    def data(self):
        return self.entry.runtime_data

    # ----- odpowiedzi -----
    async def how_much(self, user_input, result) -> str:
        query = _slot(result, "produkt")
        try:
            item = await find_item(self.data, query)
        except HomeAssistantError:
            try:
                med = await find_medicine(self.data, query)
            except HomeAssistantError:
                return f"Nie mam w zasobach nic o nazwie {query}."
            return end(f"{med['name']}: zostało {num(med['quantity'])} {med['unit']}")
        same = best(query, self.data.coordinator.data.get("all_items", []))
        if len(same) > 1:
            total = sum(r["quantity"] for r in same if r["unit"] == item["unit"])
            return end(f"{query.capitalize()}: razem {num(total)} {item['unit']} ({names(same)})")
        if item["quantity"] <= 0:
            return f"{item['name']}: brak, trzeba kupić."
        extra = f", ważne do {item['expires_at']}" if item.get("expires_at") else ""
        place = f", {item['location']}" if item.get("location") else ""
        return end(f"{item['name']}: {num(item['quantity'])} {item['unit']}{place}{extra}")

    async def for_symptom(self, user_input, result) -> str:
        symptom = _slot(result, "objaw")
        rows = medicines_for(self.data.coordinator.data.get("all_medicines", []), symptom)
        if not rows:
            return f"W apteczce nie ma leku opisanego jako na {symptom}."
        parts = []
        for r in rows[:4]:
            desc = f"{r['name']} ({num(r['quantity'])} {r['unit']}"
            desc += f", {r['person']}" if r.get("person") else ""
            desc += f", leży: {r['kit']}" if r.get("kit") else ""
            parts.append(desc + ")")
        return f"Na {symptom}: " + "; ".join(parts) + ". Sprawdź dawkowanie w ulotce."

    async def give(self, user_input, result) -> str:
        text = _slot(result, "lek")
        persons = await known_persons(self.data)
        who = ""
        if " dla " in f" {text} ":
            text, who = text.rsplit(" dla ", 1)
        else:
            first, _, rest = text.partition(" ")
            if rest and any(word_match(key(first), key(p)) for p in persons):
                who, text = first, rest
        spoken = who.strip()
        if who:
            who = match_person(who, persons)
        try:
            med = await find_medicine(self.data, text)
        except HomeAssistantError:
            return f"Nie znalazłem leku {text} w apteczce."
        dose = 5 if med["unit"] == "ml" else 1
        try:
            res = await self.data.client.take_medicine(med["id"], dose, who, "Asystent głosowy")
        except HomeManagerError as err:
            return f"Nie udało się zapisać: {err}"
        await self.data.coordinator.async_request_refresh()
        whom = f" dla {spoken.capitalize()}" if who else ""
        return end(f"Zapisałem {num(dose)} {med['unit']} {med['name']}{whom}. Zostało {num(res['quantity'])} {res['unit']}")

    async def shopping(self, user_input, result) -> str:
        await self.data.coordinator.async_request_refresh()
        items = self.data.coordinator.data["shopping"]
        if not items:
            return "Lista zakupów jest pusta."
        return end("Do kupienia: " + ", ".join(f"{i['name']} {num(i['to_buy'])} {i['unit']}" for i in items[:10]))

    async def plans(self, user_input, result, offset: int) -> str:
        day = dt_util.now().date() + timedelta(days=offset)
        try:
            events = await self.data.client.events(day.isoformat(), day.isoformat(), home=True)
        except HomeManagerError as err:
            return f"Nie udało się sprawdzić kalendarza: {err}"
        label = "Dziś" if offset == 0 else "Jutro"
        # Głośnik słyszą wszyscy domownicy – prywatnych wpisów nie czytamy na głos.
        events = [e for e in events if e.get("visibility") != "private"]
        if not events:
            return f"{label} nic nie ma w kalendarzu."
        parts = [(f"o {e['start_time']} " if e.get("start_time") else "") + e["title"] for e in events]
        return f"{label}, {WEEKDAYS[day.weekday()]}: " + "; ".join(parts) + "."

    async def use(self, user_input, result, mode: str) -> str:
        query = _slot(result, "produkt")
        try:
            item = await find_item(self.data, query)
        except HomeAssistantError:
            return f"Nie mam w zasobach {query}."
        if item["quantity"] <= 0:
            return f"{item['name']}: już nic nie ma na stanie."
        try:
            res = await self.data.client.adjust_item(item["id"], -min(1, item["quantity"]), mode)
        except HomeManagerError as err:
            return f"Nie udało się: {err}"
        await self.data.coordinator.async_request_refresh()
        verb = "Wyrzucono" if mode == "wasted" else "Zużyto"
        return end(f"{verb} 1 {res['unit']} {res['name']}. Zostało {num(res['quantity'])} {res['unit']}")

    async def expired(self, user_input, result) -> str:
        await self.data.coordinator.async_request_refresh()
        d = self.data.coordinator.data
        parts = []
        if d["expired_items"]:
            parts.append("produkty: " + names(d["expired_items"]))
        if d["medicines"]["expired"]:
            parts.append("leki: " + names(d["medicines"]["expired"]) + " – oddaj je w aptece")
        return ("Po terminie są " + "; ".join(parts) + ".") if parts else "Nic nie jest po terminie."


SENTENCES = {
    "how_much": ["ile (mamy|jest|zostało) [jeszcze] {produkt}", "czy mamy [jeszcze] {produkt}"],
    "for_symptom": ["co [mamy] na {objaw}", "co (mogę|można) (dać|podać|wziąć) na {objaw}", "jaki lek na {objaw}"],
    "give": ["podaj {lek}", "(podałem|podałam|zapisz podanie) {lek}"],
    "shopping": ["co (jest|mamy) do kupienia", "(co|czego) (trzeba|musimy|mamy) kupić", "lista zakupów", "czego brakuje"],
    "today": ["co [mamy|jest] (dziś|dzisiaj) [w kalendarzu]", "(jakie|co) [mamy] plany na (dziś|dzisiaj)", "co w kalendarzu"],
    "tomorrow": ["co [mamy|jest] jutro [w kalendarzu]", "(jakie|co) [mamy] plany na jutro"],
    "use": ["zużyj {produkt}", "(zużyłem|zużyłam|zjadłem|zjadłam|wypiłem|wypiłam) {produkt}"],
    "waste": ["(wyrzuć|wyrzuciłem|wyrzuciłam) {produkt}"],
    "expired": ["co jest po terminie", "co (się) przeterminowało", "co (straciło|traci) ważność"],
}


@callback
def async_register(hass: HomeAssistant, entry: HomeManagerConfigEntry) -> None:
    """Rejestruje zdania w domyślnym agencie rozmów (jeśli „conversation” działa)."""
    if "conversation" not in hass.config.components:
        _LOGGER.debug("Asystent (conversation) nie jest włączony – komendy głosowe pominięte")
        return
    from homeassistant.components.conversation.agent_manager import get_agent_manager
    from homeassistant.components.conversation.trigger import TriggerDetails

    assist = Assist(hass, entry)
    handlers = {
        "how_much": assist.how_much,
        "for_symptom": assist.for_symptom,
        "give": assist.give,
        "shopping": assist.shopping,
        "today": lambda u, r: assist.plans(u, r, 0),
        "tomorrow": lambda u, r: assist.plans(u, r, 1),
        "use": lambda u, r: assist.use(u, r, "used"),
        "waste": lambda u, r: assist.use(u, r, "wasted"),
        "expired": assist.expired,
    }
    manager = get_agent_manager(hass)
    for name, sentences in SENTENCES.items():
        handler = handlers[name]

        async def _cb(user_input, result, handler=handler) -> str:
            try:
                return await handler(user_input, result)
            except Exception:  # odpowiedź głosowa zamiast błędu bez słowa
                _LOGGER.exception("Asystent: błąd obsługi komendy")
                return "Coś poszło nie tak przy łączeniu z aplikacją Zasoby domowe."

        entry.async_on_unload(manager.register_trigger(TriggerDetails(sentences=sentences, callback=_cb)))
