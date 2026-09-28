"""Controller readings and rain-policy explanation."""
import math
from homeassistant.components.sensor import SensorEntity, SensorDeviceClass
from homeassistant.const import UnitOfElectricPotential, UnitOfElectricCurrent, UnitOfTime
from .entity import Entity

DESCRIPTIONS = [
    ("voltageV", "Voltage", UnitOfElectricPotential.VOLT, SensorDeviceClass.VOLTAGE),
    ("current", "Current", UnitOfElectricCurrent.MILLIAMPERE, SensorDeviceClass.CURRENT),
    ("rainShutDown", "Rain delay remaining", UnitOfTime.SECONDS, SensorDeviceClass.DURATION),
    ("active", "Running zones", None, None),
    ("weather", "Weather decision", None, None),
]


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities(Reading(entry.runtime_data, *description) for description in DESCRIPTIONS)


class Reading(Entity, SensorEntity):
    def __init__(self, coordinator, key, name, unit, device_class):
        super().__init__(coordinator, key)
        self.key = key
        self._attr_name = name
        self._attr_native_unit_of_measurement = unit
        self._attr_device_class = device_class

    @property
    def native_value(self):
        data = self.coordinator.data
        if self.key == "active":
            return sum(bool(z["running"]) for z in data["zones"])
        if self.key == "weather":
            return (data.get("weatherDecision") or {}).get("reason", "Waiting for weather")[:255]
        value = data.get("status", {}).get(self.key)
        try:
            numeric = float(value)
            return numeric if math.isfinite(numeric) else None
        except (ValueError, TypeError):
            return None

    @property
    def extra_state_attributes(self):
        if self.key == "weather":
            return self.coordinator.data.get("weatherDecision") or {}
        return {"observed_at": self.coordinator.data.get("observedAt")}
