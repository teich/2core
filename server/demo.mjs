const NAMES = [
  'Primary bedroom deck pots',
  'Rear Lawn',
  'Rear lawn drip',
  'Timber steps',
  'Patio upper',
  'Patio lower',
  'Citrus and entry pots',
  'Rose arbor',
  'Front lawn pop-ups',
  'Front lawn terrace',
  'Orchard',
  'Vegetable garden',
];

export class DemoDriver {
  // delayMs imitates a slow controller so the UI's waiting states can be seen.
  constructor({ delayMs = 0 } = {}) {
    this.runs = [];
    this.rainUntil = 0;
    this.nextHandle = 1;
    this.delayMs = delayMs;
  }
  state() {
    const now = Date.now();
    this.runs = this.runs.filter(r => r.endsAt > now);
    return {
      controller: { id: 2479, name: 'Garden simulator', type: 'LTD' },
      receivedAt: new Date(now).toISOString(),
      status: {
        controllerMode: '2',
        voltageV: 34.9,
        current: this.runs.length ? 85 : 19,
        currentFlow: this.runs.length ? 4 : 0,
        rainShutDown: Math.max(0, Math.ceil((this.rainUntil - now) / 1000)),
      },
      alarms: [],
      stations: NAMES.map((name, i) => ({
        StId: String(i + 1),
        name,
        label: `ST${i + 1}`,
        isRunning: this.runs.some(r => r.zone === String(i + 1)),
        runningEntries: this.runs
          .filter(r => r.zone === String(i + 1))
          .map(r => ({
            handleID: r.handle,
            runningMode: 'Manually Started',
            remainingSeconds: Math.max(0, Math.ceil((r.endsAt - now) / 1000)),
          })),
      })),
    };
  }
  pause() {
    return new Promise(resolve => setTimeout(resolve, this.delayMs));
  }
  async withSession(fn) {
    return fn({
      snapshot: () => this.state(),
      start: async (zone, minutes) => {
        await this.pause();
        const handle = this.nextHandle++;
        this.runs.push({ zone, handle, endsAt: Date.now() + minutes * 60000 });
        return { handle };
      },
      stop: async handles => {
        await this.pause();
        this.runs = this.runs.filter(r => !handles.includes(r.handle));
      },
      rain: async hours => {
        this.rainUntil = hours ? Date.now() + hours * 3600000 : 0;
      },
    });
  }
}
