// Compares each zone's weekly watering on the controller with 2core's plan.
// Reads a running 2core server (GET /api/state and /api/programs, which serve
// its cache and never contact Tucor) or two saved JSON files.
import { readFileSync } from 'node:fs';
import { compareWatering } from '../lib/program-compare.mjs';

const USAGE = `Usage:
  node tools/compare-programs.mjs SERVER_URL          e.g. http://192.168.1.20:8787
  node tools/compare-programs.mjs STATE.json PROGRAMS.json

Options:
  --threshold N   flag zones whose weekly time differs by more than N% (default 10)
  --json          print the comparison as JSON

Set TWOCORE_KEY to the 2core access key, unless the server signs you in through Tailscale.`;

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i < 0 ? null : (args.splice(i, name === '--json' ? 1 : 2).at(1) ?? true);
};
const json = option('--json');
const threshold = Number(option('--threshold') ?? 10);
if (!args.length || args.length > 2 || !Number.isFinite(threshold)) {
  console.error(USAGE);
  process.exit(1);
}

async function load() {
  if (args.length === 2) return args.map(file => JSON.parse(readFileSync(file, 'utf8')));
  const base = args[0].replace(/\/$/, '');
  const headers = process.env.TWOCORE_KEY ? { Authorization: `Bearer ${process.env.TWOCORE_KEY}` } : {};
  return Promise.all(
    ['/api/state', '/api/programs'].map(async path => {
      const response = await fetch(base + path, { headers });
      if (response.status === 401) throw new Error('2core asked for the access key; set TWOCORE_KEY');
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
      return response.json();
    }),
  );
}

const [state, programs] = await load();
if (!programs.observedAt) {
  console.error('2core hasn’t read the controller’s programs yet. Open the app once, then try again.');
  process.exit(2);
}
const result = compareWatering({ programs: programs.programs, intents: state.plan.intents, zones: state.zones });
if (json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const minutes = s => `${Math.round(s / 60)}`;
const times = (seconds, perWeek) => `${minutes(seconds)} min × ${+perWeek.toFixed(1)}/wk`;
const percent = change => (change === null ? 'new' : `${change > 0 ? '+' : ''}${Math.round(change * 100)}%`);
const runs = r => r.controller.runs.map(run => times(run.seconds, run.perWeek)).join(' + ') || '—';
const flagged = r => r.change === null || Math.abs(r.change) * 100 > threshold;

const table = result.zones.map(r => [
  flagged(r) ? '!' : '',
  r.id,
  r.name.length > 32 ? `${r.name.slice(0, 31)}…` : r.name,
  runs(r),
  r.plan ? times(r.plan.seconds, r.plan.perWeek) : '—',
  `${minutes(r.controller.weekly)} → ${minutes(r.plan?.weekly ?? 0)}`,
  percent(r.change),
]);
const header = ['', 'Zone', '', 'Controller', '2core plan', 'Min/week', 'Change'];
const widths = header.map((h, i) => Math.max(h.length, ...table.map(row => row[i].length)));
const line = row =>
  row.map((cell, i) => (i === 1 || i >= 5 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ');
console.log(line(header));
for (const row of table) console.log(line(row));
const { totals } = result;
console.log(
  `\nTotal: ${minutes(totals.controller)} min a week on the controller, ${minutes(totals.plan)} in the plan (${percent(totals.change)}).`,
);
console.log(
  `! marks zones that differ by more than ${threshold}%. Read on ${new Date(programs.observedAt).toLocaleString()}.`,
);
