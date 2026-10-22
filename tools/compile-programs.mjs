// Offline dry run: snapshot JSON from /api/state; never contacts the controller.
// With --programs (JSON from /api/programs), prints the Tucor messages that
// would write the candidate instead; nothing is sent.
import { readFileSync } from 'node:fs';
import { compilePrograms } from '../lib/program-compiler.mjs';
import { programMessages } from '../lib/program-messages.mjs';
import { readCapabilities } from '../lib/programs.mjs';
import { currentNight, dateKey, fromKey, sunrise, validDateKey } from '../lib/planner.mjs';
const args = process.argv.slice(2);
const flag = args.indexOf('--programs');
const programsFile = flag < 0 ? null : args.splice(flag, 2)[1];
const [file, date, ...enable] = args;
if (!file || (flag >= 0 && !programsFile) || (date && !validDateKey(date)) || enable.some(id => !/^\d+$/.test(id))) {
  console.error(
    'Usage: TZ=America/Los_Angeles node tools/compile-programs.mjs [--programs PROGRAMS.json] SNAPSHOT.json [YYYY-MM-DD [ZONE_TO_ENABLE ...]]',
  );
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8'));
const zones = snapshot.zones.filter(
  z => z.configured !== false || (snapshot.plan.intents[z.id]?.seconds && snapshot.plan.intents[z.id]?.cadence),
);
if (enable.some(id => !zones.some(z => z.id === id))) throw new Error('Unknown zone override');
const result = compilePrograms({
  zones,
  ...snapshot.plan,
  start: date ? fromKey(date) : currentNight(),
  enabledOverrides: Object.fromEntries(enable.map(id => [id, true])),
  sunriseAt: d => (snapshot.location ? sunrise(d, snapshot.location.latitude, snapshot.location.longitude) : null),
});
if (!programsFile) {
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'candidate') process.exitCode = 2;
} else {
  const programs = JSON.parse(readFileSync(programsFile, 'utf8'));
  const latest = programs.backups?.latest;
  const messages = programMessages({
    candidate: result,
    current: latest?.list ?? [],
    capabilities: readCapabilities(latest?.capabilities),
    today: dateKey(new Date()),
    readDate: latest?.receivedAt ? dateKey(new Date(latest.receivedAt)) : undefined,
  });
  console.log(JSON.stringify({ ...messages, compilerIssues: result.issues }, null, 2));
  if (messages.status !== 'ready') process.exitCode = 2;
}
