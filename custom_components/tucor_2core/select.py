"""Weather policy mode, initially observation only."""
from homeassistant.components.select import SelectEntity
from .entity import Entity


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([WeatherMode(entry.runtime_data)])


class WeatherMode(Entity, SelectEntity):
    _attr_name = "Weather mode"
    _attr_options = ["off", "observe", "automatic"]

    def __init__(self, coordinator):
        super().__init__(coordinator, "weather_mode")

    @property
    def current_option(self):
        return self.coordinator.data["policy"]["mode"]

    async def async_select_option(self, option):
        await self.coordinator.command("/policy", {"mode": option})
