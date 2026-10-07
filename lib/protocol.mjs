// Reconstructed from Tucor's deployed frontend. No network side effects here.
export const ORIGIN = 'https://tucor.mysrc.online';

function integer(value, name, min, max) {
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return n;
}

export function plan(action, value, duration) {
  switch (action) {
    case 'zone-start': {
      // UI passes Data.StId as a scalar string, not the display name or OID.
      const id = String(integer(value, 'station ID', 1, 100));
      const minutes = integer(duration, 'minutes', 1, 1079);
      return [
        { event: 'message', data: { component: 'Stations', command: 'Start', id, time: minutes * 60 } },
        { event: 'message', data: { component: 'Stations', command: 'AutoStatus', switch: 'on' } },
      ];
    }
    case 'zone-stop':
      return [
        {
          event: 'message',
          data: {
            component: 'Stations',
            command: 'Stop',
            handleID: [integer(value, 'running-entry handle', 0, Number.MAX_SAFE_INTEGER)],
          },
        },
        { event: 'message', data: { component: 'Stations', command: 'AutoStatus', switch: 'on' } },
      ];
    case 'rain-start': {
      const hours = integer(value, 'hours', 1, 999);
      // The actual UI calls Stop(), then waits one second before Start().
      return [
        { event: 'message', data: { component: 'Rainshutdown', command: 'Stop' } },
        { waitMs: 1000 },
        { event: 'message', data: { component: 'Rainshutdown', command: 'Start', runtime: hours * 3600 } },
      ];
    }
    case 'rain-stop':
      return [{ event: 'message', data: { component: 'Rainshutdown', command: 'Stop' } }];
    default:
      throw new Error('Unknown plan; use zone-start, zone-stop, rain-start, or rain-stop');
  }
}

export function devicesFromResponse(response) {
  const devices = response?.getdevicelistnew?.[0]?.devicelist;
  if (!Array.isArray(devices)) throw new Error('Unexpected device-list response');
  return devices.map(d => ({
    id: d.ctrlid,
    name: d.description,
    type: d.typename,
    busy: Number(d.active) > 0,
    online: d.online,
    state: d.newstate,
  }));
}

export function groupFor(type) {
  const group = type.slice(0, 3).toUpperCase();
  return group === 'GRO' ? 'TWC' : group;
}

export function historyGroupFor(type) {
  return groupFor(type) === 'TWC' ? 'twc' : 'rkx';
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value.replace(/([?&](?:token|auth_token)=)[^&\s"]+/gi, '$1[REDACTED]');
    for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(?:password|password2|token|auth|auth_token|authorization|cookie|set-cookie)$/i.test(k)
          ? '[REDACTED]'
          : redact(v, secrets),
      ]),
    );
  }
  return value;
}

export function summarize(messages) {
  const result = { receivedAt: new Date().toISOString(), components: [], status: {}, stations: [] };
  const seen = new Set();
  let inventory = [];
  let hasStationSnapshot = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const data = message.data ?? message;
    if (message.component) seen.add(message.component);
    if (['Main', 'Flow', 'ElectricFlow'].includes(message.component) && !Array.isArray(data)) {
      if (Array.isArray(data.decoderList)) inventory = data.decoderList;
      if (Array.isArray(data.alarm)) result.alarms = data.alarm;
      for (const key of [
        'controllerMode',
        'current',
        'currentFlow',
        'expectedFlow',
        'systemCapacity',
        'rainShutDown',
        'daily_et',
        'daily_rain',
        'hourly_rain',
        'waterConsumption',
      ]) {
        if (data[key] !== undefined) result.status[key] = data[key];
      }
      if (data.voltage !== undefined && Number.isFinite(Number(data.voltage)))
        result.status.voltageV = Number(data.voltage) / 100;
    }
    if (message.category === 'server' && data.code) result.lastServerCode = data.code;
    if (message.category === 'device' && data.type === 'datetime') result.controllerTimeRaw = data.item;
    if (message.component === 'Stations' && Array.isArray(data)) {
      hasStationSnapshot = true;
      if (!result.stations.length) result.stations = structuredClone(data);
      else {
        // Subsequent non-TWC station messages list running stations only.
        const updates = new Map(data.map(s => [String(s.StId), s]));
        result.stations = result.stations.map(s => {
          const update = updates.get(String(s.StId));
          if (!update) return { ...s, isRunning: false, stStat: 'Passive', runningEntries: [] };
          const { name, description, expectedFlow, precip, status, ...runtime } = update;
          updates.delete(String(s.StId));
          return { ...s, ...runtime };
        });
        result.stations.push(...updates.values());
      }
    }
  }
  if (inventory.length) {
    const active = new Map(result.stations.map(s => [String(s.StId), s]));
    result.stations = inventory.map(d => ({
      isRunning: hasStationSnapshot ? false : null,
      runningEntries: hasStationSnapshot ? [] : null,
      ...active.get(String(d.decid)),
      // Full station packets use name='ST1'; the inventory description is the
      // user's friendly name and must win over both full and delta packets.
      StId: String(d.decid),
      label: d.name,
      name: d.description,
      oid: d.oid,
    }));
  }
  result.components = [...seen];
  return result;
}
