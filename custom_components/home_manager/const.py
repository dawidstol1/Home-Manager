"""Stałe integracji Zasoby domowe."""

from datetime import timedelta

DOMAIN = "home_manager"

CONF_TOKEN = "token"
CONF_PANEL_URL = "panel_url"
CONF_SHOW_PANEL = "show_panel"
CONF_SCAN_MINUTES = "scan_minutes"

DEFAULT_SCAN_MINUTES = 5
DEFAULT_SCAN_INTERVAL = timedelta(minutes=DEFAULT_SCAN_MINUTES)
PANEL_ICON = "mdi:home-heart"
PANEL_TITLE = "Zasoby domowe"
MANUFACTURER = "Home-Manager"
CONF_ITEM_ENTITIES = "item_entities"
CONF_VOICE = "voice"
CONF_PROXY = "via_home_assistant"
STATIC_URL = "/home_manager_static"
