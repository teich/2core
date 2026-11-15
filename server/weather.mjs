export const DEFAULT_POLICY = {
  mode: 'observe',
  intensityMmH: 0.25,
  accumulationMm: 3,
  // Expected rain over the next 12 hours: each hour's amount times its chance.
  forecastExpectedMm: 4,
  holdHours: 12,
};

// Missing/stale measurements are unknown, never zero. Policy only adds/extends holds.
export function evaluateWeather(sample, policy, now = Date.now()) {
  const age = now - Date.parse(sample.observedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 30 * 60000)
    return { wet: false, reason: 'Weather observation is stale or missing' };
  const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  // trigger carries the measurement so clients can word it in the station's units.
  let reason, trigger;
  if (finite(sample.intensityMmH) && sample.intensityMmH >= policy.intensityMmH) {
    reason = `Rain intensity ${sample.intensityMmH} mm/h`;
    trigger = { kind: 'intensity', mm: sample.intensityMmH };
  } else if (finite(sample.accumulationMm) && sample.accumulationMm >= policy.accumulationMm) {
    reason = `Rainfall today ${sample.accumulationMm} mm`;
    trigger = { kind: 'accumulation', mm: sample.accumulationMm };
  } else if (
    finite(sample.forecastExpectedMm) &&
    finite(sample.forecastMm) &&
    sample.forecastExpectedMm >= policy.forecastExpectedMm
  ) {
    reason = `Forecast ${sample.forecastMm.toFixed(1)} mm, ${sample.forecastExpectedMm.toFixed(1)} mm expected`;
    trigger = {
      kind: 'forecast',
      mm: sample.forecastMm,
      expectedMm: sample.forecastExpectedMm,
      probability: sample.forecastProbability,
    };
  }
  if (!reason) return { wet: false, reason: 'No rainfall threshold met with available measurements' };
  return { wet: true, reason, trigger, until: new Date(now + policy.holdHours * 3600000).toISOString() };
}
