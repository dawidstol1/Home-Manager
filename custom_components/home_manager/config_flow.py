"""Konfiguracja z poziomu interfejsu Home Assistant."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlowWithReload
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import CannotConnect, HomeManagerClient, HomeManagerError, InvalidAuth
from .const import (
    CONF_ITEM_ENTITIES,
    CONF_PANEL_URL,
    CONF_SCAN_MINUTES,
    CONF_SHOW_PANEL,
    CONF_TOKEN,
    CONF_VOICE,
    DEFAULT_SCAN_MINUTES,
    DOMAIN,
)


def _clean_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if "://" not in value:
        value = f"http://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise vol.Invalid("invalid_url")
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"


async def _validate(hass, url: str, token: str, verify_ssl: bool) -> dict:
    session = async_get_clientsession(hass, verify_ssl=verify_ssl)
    return await HomeManagerClient(session, url, token).me()


class HomeManagerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Adres serwera + klucz API z Ustawień → Integracje."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                url = _clean_url(user_input[CONF_URL])
            except vol.Invalid:
                errors[CONF_URL] = "invalid_url"
            else:
                await self.async_set_unique_id(url.lower())
                self._abort_if_unique_id_configured()
                try:
                    user = await _validate(self.hass, url, user_input[CONF_TOKEN].strip(), user_input[CONF_VERIFY_SSL])
                except InvalidAuth:
                    errors[CONF_TOKEN] = "invalid_auth"
                except CannotConnect:
                    errors[CONF_URL] = "cannot_connect"
                except HomeManagerError:
                    errors["base"] = "unknown"
                else:
                    return self.async_create_entry(
                        title=f"Zasoby domowe ({user.get('name', url)})",
                        data={CONF_URL: url, CONF_TOKEN: user_input[CONF_TOKEN].strip(), CONF_VERIFY_SSL: user_input[CONF_VERIFY_SSL]},
                        options={CONF_SHOW_PANEL: True, CONF_PANEL_URL: "", CONF_SCAN_MINUTES: DEFAULT_SCAN_MINUTES, CONF_ITEM_ENTITIES: True, CONF_VOICE: True},
                    )
        defaults = user_input or {}
        schema = vol.Schema(
            {
                vol.Required(CONF_URL, default=defaults.get(CONF_URL, "http://")): str,
                vol.Required(CONF_TOKEN, default=defaults.get(CONF_TOKEN, "")): str,
                vol.Required(CONF_VERIFY_SSL, default=defaults.get(CONF_VERIFY_SSL, True)): bool,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Nowy klucz, gdy stary został usunięty."""
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()
        if user_input is not None:
            try:
                await _validate(self.hass, entry.data[CONF_URL], user_input[CONF_TOKEN].strip(), entry.data[CONF_VERIFY_SSL])
            except InvalidAuth:
                errors[CONF_TOKEN] = "invalid_auth"
            except (CannotConnect, HomeManagerError):
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN].strip()})
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}),
            errors=errors,
            description_placeholders={"url": entry.data[CONF_URL]},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry) -> "HomeManagerOptionsFlow":
        return HomeManagerOptionsFlow()


class HomeManagerOptionsFlow(OptionsFlowWithReload):
    """Panel w menu i częstotliwość odświeżania."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            panel_url = user_input.get(CONF_PANEL_URL, "").strip()
            if panel_url:
                try:
                    panel_url = _clean_url(panel_url)
                except vol.Invalid:
                    errors[CONF_PANEL_URL] = "invalid_url"
            if not errors:
                return self.async_create_entry(data={**user_input, CONF_PANEL_URL: panel_url})
        opts = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(CONF_SHOW_PANEL, default=opts.get(CONF_SHOW_PANEL, True)): bool,
                vol.Optional(CONF_PANEL_URL, default=opts.get(CONF_PANEL_URL, "")): str,
                vol.Required(CONF_SCAN_MINUTES, default=opts.get(CONF_SCAN_MINUTES, DEFAULT_SCAN_MINUTES)): vol.All(
                    vol.Coerce(int), vol.Range(min=1, max=120)
                ),
                vol.Required(CONF_ITEM_ENTITIES, default=opts.get(CONF_ITEM_ENTITIES, True)): bool,
                vol.Required(CONF_VOICE, default=opts.get(CONF_VOICE, True)): bool,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema, errors=errors)
