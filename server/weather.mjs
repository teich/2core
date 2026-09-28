export const DEFAULT_POLICY = {
  mode: 'observe', intensityMmH: 0.25, accumulationMm: 3,
  forecastMm: 5, forecastProbability: 70, holdHours: 12,
};

// Missing/stale measurements are unknown, never zero. Policy only adds/extends holds.
export function evaluateWeather(sample, policy, now = Date.now()) {
  const age = now - Date.parse(sample.observedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 30 * 60000) return { wet: false, reason: 'Weather observation is stale or missing' };
  const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  let reason;
  if (finite(sample.intensityMmH) && sample.intensityMmH >= policy.intensityMmH) reason = `Rain intensity ${sample.intensityMmH} mm/h`;
  else if (finite(sample.accumulationMm) && sample.accumulationMm >= policy.accumulationMm) reason = `Recent rainfall ${sample.accumulationMm} mm`;
  else if (finite(sample.forecastMm) && finite(sample.forecastProbability) && sample.forecastMm >= policy.forecastMm && sample.forecastProbability >= policy.forecastProbability) {
    reason = `Forecast ${sample.forecastMm} mm with ${sample.forecastProbability}% probability`;
  }
  if (!reason) return { wet: false, reason: 'No rainfall threshold met with available measurements' };
  return { wet: true, reason, until: new Date(now + policy.holdHours * 3600000).toISOString() };
}
