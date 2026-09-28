"""One local poll shared by all native Home Assistant entities."""
from datetime import timedelta
import logging

from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from .api import BridgeAuthError, BridgeError
from .const import DOMAIN
from .weather import collect_weather

_LOGGER = logging.getLogger(__name__)


class Coordinator(DataUpdateCoordinator):
    def __init__(self, hass, entry, client):
        super().__init__(hass, _LOGGER, name=DOMAIN, config_entry=entry, update_interval=timedelta(seconds=5))
        self.client = client
        self.entry = entry
        self.weather_busy = False

    async def _async_update_data(self):
        try:
            return await self.client.state()
        except BridgeAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except BridgeError as err:
            raise UpdateFailed(str(err)) from err

    async def command(self, path, body):
        try:
            result = await self.client.request(path, body)
            await self.async_request_refresh()
            return result
        except BridgeError as err:
            raise HomeAssistantError(str(err)) from err

    async def weather_tick(self, _now):
        if self.weather_busy or not self.data or self.data.get("policy", {}).get("mode") == "off":
            return
        self.weather_busy = True
        try:
            sample = await collect_weather(self.hass, self.entry.options)
            if sample is not None:
                await self.command("/weather", sample)
        except HomeAssistantError as err:
            _LOGGER.warning("2core weather observation failed: %s", err)
        finally:
            self.weather_busy = False
