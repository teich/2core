import { randomUUID } from 'node:crypto';

// Only caller-controlled labels and durations belong here, never packets/URLs.
export function trace(logger = () => {}, id = randomUUID(), onStage = () => {}) {
  return {
    id,
    started: performance.now(),
    record(stage, started, outcome = 'ok', extra = {}) {
      logger({ event: 'tucor_timing', operationId: id, stage, ms: Math.round(performance.now() - started), outcome, ...extra });
    },
    async stage(stage, fn) {
      onStage(stage);
      const started = performance.now();
      try { const result = await fn(); this.record(stage, started); return result; }
      catch (error) { this.record(stage, started, 'error'); throw error; }
    },
    onStage,
  };
}
