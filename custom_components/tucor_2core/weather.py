"""Normalize selected Tempest entities and optional hourly forecasts."""
from datetime import datetime, timedelta, timezone
import math


def rain_measurement(state, intensity=False, now=None):
    """Return millimeters (per hour for intensity), or None for stale/unknown data."""
    if state is None or state.state in ("unknown", "unavailable", ""):
        return None
    now = now or datetime.now(timezone.utc)
    reported = state.last_reported
    if not -60 <= (now - reported).total_seconds() <= 1800:
        return None
    try:
        value = float(state.state)
    except (ValueError, TypeError):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    unit = state.attributes.get("unit_of_measurement", "")
    allowed = {"mm/h": 1, "in/h": 25.4} if intensity else {"mm": 1, "in": 25.4}
    factor = allowed.get(unit)
    return value * factor if factor is not None else None


def forecast_rain(rows, unit, now=None):
    """Require twelve complete hourly buckets with amount and probability."""
    now = now or datetime.now(timezone.utc)
    if unit not in ("mm", "in"):
        return None
    buckets = {}
    for row in rows:
        try:
            at = datetime.fromisoformat(row["datetime"].replace("Z", "+00:00"))
            delta = (at - now).total_seconds()
            amount = float(row["precipitation"])
            probability = float(row["precipitation_probability"])
        except (KeyError, ValueError, TypeError):
            continue
        if 0 <= delta < 12 * 3600 and math.isfinite(amount) and amount >= 0 and math.isfinite(probability) and 0 <= probability <= 100:
            bucket = int(delta // 3600)
            buckets[bucket] = (amount, probability)
    if len(buckets) != 12:
        return None
    # Conservatively use the minimum probability among hours predicting rainfall.
    wet = [p for a, p in buckets.values() if a > 0]
    return {"forecastMm": sum(a for a, _ in buckets.values()) * (25.4 if unit == "in" else 1), "forecastProbability": min(wet) if wet else 0}


async def collect_weather(hass, options):
    now = datetime.now(timezone.utc)
    sample = {"observedAt": now.isoformat()}
    times = []
    for option, key, intensity in [("intensity_entity", "intensityMmH", True), ("accumulation_entity", "accumulationMm", False)]:
        state = hass.states.get(options.get(option, ""))
        value = rain_measurement(state, intensity, now)
        if value is not None:
            sample[key] = value
            times.append(state.last_reported)
    weather_entity = options.get("weather_entity")
    weather = hass.states.get(weather_entity) if weather_entity else None
    if weather and weather.state not in ("unknown", "unavailable"):
        try:
            response = await hass.services.async_call("weather", "get_forecasts", {"entity_id": weather_entity, "type": "hourly"}, blocking=True, return_response=True)
            forecast = forecast_rain(response[weather_entity]["forecast"], weather.attributes.get("precipitation_unit"), now)
            if forecast:
                sample.update(forecast)
                times.append(now)
        except Exception:  # A forecast failure must not discard valid local rain observations.
            pass
    if not times:
        return None
    sample["observedAt"] = min(times).isoformat()
    return sample
