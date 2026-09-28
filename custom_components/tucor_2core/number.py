"""Rain-delay setter. Zero explicitly cancels the controller hold."""
import math
from homeassistant.components.number import NumberEntity, NumberMode
from .entity import Entity


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([RainDelay(entry.runtime_data)])


class RainDelay(Entity, NumberEntity):
    _attr_name = "Rain delay"
    _attr_native_min_value = 0
    _attr_native_max_value = 999
    _attr_native_step = 1
    _attr_native_unit_of_measurement = "h"
    _attr_mode = NumberMode.BOX
    _attr_icon = "mdi:weather-rainy"

    def __init__(self, coordinator):
        super().__init__(coordinator, "rain_delay")

    @property
    def native_value(self):
        value = self.coordinator.data.get("status", {}).get("rainShutDown")
        return math.ceil(float(value) / 3600) if value is not None else None

    async def async_set_native_value(self, value):
        if not math.isfinite(value) or value != int(value):
            from homeassistant.exceptions import HomeAssistantError
            raise HomeAssistantError('Rain delay must be a whole number of hours')
        await self.coordinator.command("/rain", {"hours": int(value)})
