"""Config and options flows for Home Assistant 2026.09."""
from urllib.parse import urlsplit

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import selector

from .api import BridgeClient, BridgeAuthError, BridgeError
from .const import DOMAIN, CONF_URL, CONF_KEY, DEFAULT_MINUTES


def normalize_url(value):
    url = urlsplit(value.strip())
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Use the base HTTP(S) address of the 2core server")
    return value.strip().rstrip("/")


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                user_input[CONF_URL] = normalize_url(user_input[CONF_URL])
                data = await BridgeClient(async_get_clientsession(self.hass), user_input[CONF_URL], user_input[CONF_KEY]).state()
                if not data.get('controller') or not data.get('zones'):
                    raise BridgeError('Waiting for controller inventory')
                unique = f"{data.get('mode')}:{data['controller']['id']}:{user_input[CONF_URL]}"
                await self.async_set_unique_id(unique)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="2core Irrigation", data=user_input)
            except BridgeAuthError:
                errors["base"] = "invalid_auth"
            except (BridgeError, ValueError):
                errors["base"] = "cannot_connect"
        return self.async_show_form(step_id="user", data_schema=vol.Schema({
            vol.Required(CONF_URL, default="http://2core.local:8787"): str,
            vol.Required(CONF_KEY): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
        }), errors=errors)

    async def async_step_reauth(self, entry_data):
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input=None):
        entry = self._get_reauth_entry()
        errors = {}
        if user_input is not None:
            try:
                await BridgeClient(async_get_clientsession(self.hass), entry.data[CONF_URL], user_input[CONF_KEY]).state()
                return self.async_update_reload_and_abort(entry, data_updates={CONF_KEY: user_input[CONF_KEY]})
            except BridgeAuthError:
                errors["base"] = "invalid_auth"
            except BridgeError:
                errors["base"] = "cannot_connect"
        return self.async_show_form(step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_KEY): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD))}), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return OptionsFlow()


class OptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        options = self.config_entry.options
        return self.async_show_form(step_id="init", data_schema=vol.Schema({
            vol.Required("default_minutes", default=options.get("default_minutes", DEFAULT_MINUTES)): vol.All(vol.Coerce(int), vol.Range(min=1, max=60)),
            vol.Optional("intensity_entity", description={"suggested_value": options.get("intensity_entity")}): selector.EntitySelector(selector.EntitySelectorConfig(domain="sensor")),
            vol.Optional("accumulation_entity", description={"suggested_value": options.get("accumulation_entity")}): selector.EntitySelector(selector.EntitySelectorConfig(domain="sensor")),
            vol.Optional("weather_entity", description={"suggested_value": options.get("weather_entity")}): selector.EntitySelector(selector.EntitySelectorConfig(domain="weather")),
        }))
