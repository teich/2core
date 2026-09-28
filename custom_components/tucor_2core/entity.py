"""Common controller identity and availability."""
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN


class Entity(CoordinatorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator, key):
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{key}"
        controller = coordinator.data.get("controller") or {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry.entry_id)},
            name=controller.get("name", "2core Irrigation"), manufacturer="Tucor",
            model=controller.get("type", "Irrigation controller"),
            configuration_url=coordinator.client.url,
        )

    @property
    def available(self):
        return super().available and bool(self.coordinator.data.get("available"))
