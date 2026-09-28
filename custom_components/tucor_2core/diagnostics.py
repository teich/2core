"""Sanitized integration diagnostics; no access keys or garden notes."""
async def async_get_config_entry_diagnostics(hass, entry):
    coordinator = entry.runtime_data
    data = coordinator.data or {}
    return {
        "mode": data.get("mode"), "available": data.get("available"),
        "control_enabled": data.get("controlEnabled"), "observed_at": data.get("observedAt"),
        "zone_count": len(data.get("zones", [])), "policy": data.get("policy"),
        "weather_configured": {key: bool(entry.options.get(key)) for key in ("intensity_entity", "accumulation_entity", "weather_entity")},
    }
