export const DEFAULT_POLICY = {
  mode: 'observe', intensityMmH: 0.25, accumulationMm: 3,
  forecastMm: 5, forecastProbability: 70, holdHours: 12,
};

// Missing/stale measurements are unknown, never zero. Policy only adds/extends holds.
export function evaluateWeather(sample, policy, now = Date.now()) {
  const age = now - Date.parse(sample.observedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 30 * 60000) return { wet: false, reason: 'Weather observation is stale or missing' };
  const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  // trigger carries the measurement so clients can word it in the station's units.
  let reason, trigger;
  if (finite(sample.intensityMmH) && sample.intensityMmH >= policy.intensityMmH) {
    reason = `Rain intensity ${sample.intensityMmH} mm/h`; trigger = { kind: 'intensity', mm: sample.intensityMmH };
  } else if (finite(sample.accumulationMm) && sample.accumulationMm >= policy.accumulationMm) {
    reason = `Rainfall today ${sample.accumulationMm} mm`; trigger = { kind: 'accumulation', mm: sample.accumulationMm };
  } else if (finite(sample.forecastMm) && finite(sample.forecastProbability) && sample.forecastMm >= policy.forecastMm && sample.forecastProbability >= policy.forecastProbability) {
    reason = `Forecast ${sample.forecastMm} mm with ${sample.forecastProbability}% probability`; trigger = { kind: 'forecast', mm: sample.forecastMm, probability: sample.forecastProbability };
  }
  if (!reason) return { wet: false, reason: 'No rainfall threshold met with available measurements' };
  return { wet: true, reason, trigger, until: new Date(now + policy.holdHours * 3600000).toISOString() };
}
