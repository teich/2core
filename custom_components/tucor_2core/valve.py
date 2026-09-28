"""Zone valves; opening always starts a bounded timed run."""
from homeassistant.components.valve import ValveEntity, ValveEntityFeature, ValveDeviceClass
from .const import DEFAULT_MINUTES
from .entity import Entity

PARALLEL_UPDATES = 1


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = entry.runtime_data
    async_add_entities(ZoneValve(coordinator, z) for z in coordinator.data["zones"])


class ZoneValve(Entity, ValveEntity):
    _attr_supported_features = ValveEntityFeature.OPEN | ValveEntityFeature.CLOSE
    _attr_device_class = ValveDeviceClass.WATER
    _attr_reports_position = False

    def __init__(self, coordinator, zone):
        super().__init__(coordinator, f"zone_{zone['id']}")
        self.zone_id = zone["id"]
        self._attr_entity_registry_enabled_default = zone["configured"]

    @property
    def zone(self):
        return next((z for z in self.coordinator.data["zones"] if z["id"] == self.zone_id), None)

    @property
    def name(self):
        return self.zone["name"] if self.zone else f"Zone {self.zone_id}"

    @property
    def is_closed(self):
        return not self.zone["running"] if self.zone and self.zone["running"] is not None else None

    @property
    def extra_state_attributes(self):
        zone = self.zone or {}
        return {"zone": self.zone_id, "owned_by_2core": zone.get("owned"), "ends_at": zone.get("endsAt"), "default_minutes": self.coordinator.entry.options.get("default_minutes", DEFAULT_MINUTES)}

    async def async_open_valve(self):
        await self.coordinator.command(f"/zones/{self.zone_id}/start", {"minutes": self.coordinator.entry.options.get("default_minutes", DEFAULT_MINUTES)})

    async def async_close_valve(self):
        await self.coordinator.command(f"/zones/{self.zone_id}/stop", {})
