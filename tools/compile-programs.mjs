// Offline dry run: snapshot JSON from /api/state; never contacts the controller.
import { readFileSync } from 'node:fs';
import { compilePrograms } from '../lib/program-compiler.mjs';
import { currentNight, fromKey, sunrise, validDateKey } from '../lib/planner.mjs';
const [file, date, ...enable] = process.argv.slice(2);
if (!file || date && !validDateKey(date) || enable.some(id => !/^\d+$/.test(id))) {
  console.error('Usage: TZ=America/Los_Angeles node tools/compile-programs.mjs SNAPSHOT.json [YYYY-MM-DD [ZONE_TO_ENABLE ...]]');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8'));
const zones = snapshot.zones.filter(z => z.configured !== false || snapshot.plan.intents[z.id]);
if (enable.some(id => !zones.some(z => z.id === id))) throw new Error('Unknown zone override');
const result = compilePrograms({ zones, ...snapshot.plan, start: date ? fromKey(date) : currentNight(),
  enabledOverrides: Object.fromEntries(enable.map(id => [id, true])),
  sunriseAt: d => snapshot.location ? sunrise(d, snapshot.location.latitude, snapshot.location.longitude) : null });
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'candidate') process.exitCode = 2;
