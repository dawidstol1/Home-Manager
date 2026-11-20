"""Klient REST API serwera Zasoby domowe (Home-Manager)."""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp


class HomeManagerError(Exception):
    """Ogólny błąd komunikacji."""


class CannotConnect(HomeManagerError):
    """Serwer nie odpowiada albo odpowiada błędem."""


class InvalidAuth(HomeManagerError):
    """Klucz API jest nieprawidłowy albo został usunięty."""


class HomeManagerClient:
    """Wywołania API z kluczem w nagłówku Authorization: Bearer."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self._session = session
        self.url = url.rstrip("/")
        self._token = token

    async def request(self, method: str, path: str, json: Any = None, params: dict | None = None) -> Any:
        """Wywołuje API i zwraca odpowiedź JSON (None dla 204)."""
        try:
            async with asyncio.timeout(20):
                resp = await self._session.request(
                    method,
                    f"{self.url}/api{path}",
                    json=json,
                    params=params,
                    headers={"Authorization": f"Bearer {self._token}", "Accept": "application/json"},
                )
                if resp.status == 204:
                    return None
                try:
                    data = await resp.json(content_type=None)
                except ValueError:
                    data = None
                message = data.get("error") if isinstance(data, dict) else None
                if resp.status == 401:
                    raise InvalidAuth(message or "Nieprawidłowy klucz API")
                if resp.status >= 400:
                    raise HomeManagerError(message or f"Błąd {resp.status}")
                if data is None:
                    raise CannotConnect("Serwer nie zwrócił danych JSON – sprawdź adres")
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise CannotConnect(str(err) or err.__class__.__name__) from err

    async def me(self) -> dict:
        return await self.request("GET", "/auth/me")

    async def summary(self) -> dict:
        return await self.request("GET", "/integration/summary")

    async def events(self, start: str, end: str, home: bool = True) -> list[dict]:
        return await self.request("GET", "/events", params={"from": start, "to": end, **({"home": "1"} if home else {})})

    async def create_event(self, data: dict) -> dict:
        return await self.request("POST", "/events", json=data)

    async def delete_event(self, event_id: int) -> None:
        await self.request("DELETE", f"/events/{event_id}")

    async def buy_item(self, item_id: int, quantity: float) -> dict:
        return await self.request("POST", f"/items/{item_id}/adjust", json={"delta": quantity, "note": "Zakup (Home Assistant)"})

    async def consume(self, barcode: str, reason: str = "used") -> dict:
        return await self.request("POST", "/consume", json={"barcode": barcode, "reason": reason})

    async def medicines(self, query: str | None = None) -> list[dict]:
        return await self.request("GET", "/medicines", params={"q": query} if query else None)

    async def take_medicine(self, medicine_id: int, amount: float, person: str = "", note: str = "") -> dict:
        return await self.request("POST", f"/medicines/{medicine_id}/take", json={"amount": amount, "person": person, "note": note})

    # ----- Zasoby i apteka (pełne listy dla encji i Asystenta) -----
    async def items(self, query: str | None = None, status: str | None = None) -> list[dict]:
        params = {k: v for k, v in (("q", query), ("status", status)) if v}
        return await self.request("GET", "/items", params=params or None)

    async def adjust_item(self, item_id: int, delta: float, reason: str | None = None) -> dict:
        body: dict = {"delta": delta}
        if reason:
            body["reason"] = reason
        if delta > 0:
            body["note"] = "Home Assistant"
        return await self.request("POST", f"/items/{item_id}/adjust", json=body)

    async def create_item(self, data: dict) -> dict:
        return await self.request("POST", "/items", json=data)

    async def dictionary(self, kind: str) -> list[dict]:
        return await self.request("GET", f"/{kind}")

    async def add_medicine_pack(self, medicine_id: int, quantity: float, expires_at: str | None = None) -> dict:
        return await self.request("POST", f"/medicines/{medicine_id}/packs", json={"quantity": quantity, "expires_at": expires_at})

    async def users(self) -> list[dict]:
        return await self.request("GET", "/users")

    async def shopping(self) -> list[dict]:
        return await self.request("GET", "/shopping-list")
