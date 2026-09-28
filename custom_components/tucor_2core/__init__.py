"""Native Home Assistant integration for the local 2core server."""
from datetime import timedelta
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers import config_validation as cv

from .api import BridgeClient
from .const import DOMAIN, PLATFORMS, CONF_URL, CONF_KEY
from .coordinator import Coordinator

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config):
    async def handle(call: ServiceCall):
        entry = hass.config_entries.async_get_entry(call.data["config_entry_id"])
        if entry is None or entry.domain != DOMAIN or not hasattr(entry, "runtime_data"):
            raise HomeAssistantError("Select a loaded 2core integration")
        coordinator = entry.runtime_data
        if call.service == "start_zone":
            await coordinator.command(f"/zones/{call.data['zone']}/start", {"minutes": call.data["minutes"]})
        elif call.service == "stop_zone":
            await coordinator.command(f"/zones/{call.data['zone']}/stop", {})
        elif call.service == "stop_my_watering":
            await coordinator.command("/stop", {})
        elif call.service == "set_rain_delay":
            await coordinator.command("/rain", {"hours": call.data["hours"]})

    common = {vol.Required("config_entry_id"): cv.string}
    zone = {vol.Required("zone"): vol.All(vol.Coerce(int), vol.Range(min=1, max=100))}
    schemas = {
        "start_zone": {**common, **zone, vol.Required("minutes", default=1): vol.All(vol.Coerce(int), vol.Range(min=1, max=60))},
        "stop_zone": {**common, **zone},
        "stop_my_watering": common,
        "set_rain_delay": {**common, vol.Required("hours"): vol.All(vol.Coerce(int), vol.Range(min=0, max=999))},
    }
    for name, schema in schemas.items():
        hass.services.async_register(DOMAIN, name, handle, schema=vol.Schema(schema))
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry):
    client = BridgeClient(async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_KEY])
    coordinator = Coordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    if not coordinator.data.get("zones"):
        from homeassistant.exceptions import ConfigEntryNotReady
        raise ConfigEntryNotReady("Waiting for the bridge's first controller inventory")
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(async_track_time_interval(hass, coordinator.weather_tick, timedelta(minutes=5)))
    entry.async_on_unload(entry.add_update_listener(_options_updated))
    return True


async def _options_updated(hass, entry):
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass, entry):
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
