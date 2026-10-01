# Tucor intent scheduling plan

2core should store what each zone needs and show the watering schedule that follows from those intentions. Build the intent interface and a simple preview first. Use the actual intentions to decide how much scheduling machinery is needed.

Nightly compilation into Tucor programs is the preferred execution approach to validate. It fits the priority of minimizing Tucor cloud contact and the owner's experience that controller programs run very reliably: no remembered skips except during power outages. Direct zone execution remains an alternative if program writes or controller limits make compilation impractical. Neither approach is a prerequisite for the intent interface.

This proposal incorporates repository inspection, read-only production queries on September 30, 2026, the owner's operating experience, and review feedback. No watering, program configuration, or deployment changes were made as part of this plan.

## Scope and working defaults

- This is for one owner and one irrigation system. Solve the actual schedule before generalizing for hypothetical cases.
- Be a good Tucor citizen: minimize cloud contact, avoid background polling, and preserve the existing twenty-session-per-hour and six-password-login-per-day limits. Occasional schedule and rain-hold writes fit that priority better than supervising every zone overnight.
- At most two zones may water simultaneously, including automatic and manual work. No additional incompatible zone combinations or soak requirements are currently known.
- Prefer finishing before sunrise. Exact timing is not mission critical.
- Intervals count from watering; rain skips postpone watering and shift later dates. Twice a week means roughly every three to four days.
- Define fresh intentions and preview their consequences before replacing controller schedules. Existing programs are comparison data, not constraints on what the owner can express.

Use three editable timing settings: an earliest start of 10pm, a **preferred finish** fifteen minutes before sunrise, and a **hard deadline** of 9am. Defer the optional 80°F forecast cutoff unless the actual preview shows a need for it. These are proposed product defaults, not watering advice or fixed requirements.

## What we know

The bridge reports controller 2479, type LTD, with 28 named zones across 100 slots. It currently permits only one manual zone at a time. It already has SQLite storage, serialized commands, duplicate-request protection, bounded controller timers, and weather-aware rain holds. It has no intent model or autonomous scheduler.

A bounded read returned ten configured programs, six active and four passive. Reported capabilities include sequential operation, one station per step, twelve starts per program, no linked programs, and calendars of fourteen days, odd dates, or even dates. A repeating fourteen-day mask cannot encode a perpetual every-third-day cadence exactly. Compiling a fresh night could avoid that limitation, provided the calendar's date mapping is verified. See the [LTD data sheet](https://tucor.com/wp-content/uploads/2023/09/RK_Data-Sheet_LTD-2-Wire-Controller-Data-Sheet_015-DA-1.pdf).

Current active programs provide a useful duration comparison:

| Program | Start | Base duration | Budget | Modeled duration |
| --- | --- | --- | --- | --- |
| Weekly trees | 4am | 115 min | 100% | 115 min |
| Pots | 4am | 28 min 20 sec | 100% | 28 min 20 sec |
| Hills | 3am | 120 min | 130% | 156 min |
| Fruits | 1:30am | 35 min | 120% | 42 min |
| Even dates | 10pm | 202 min | 145% | 292 min 54 sec |
| Odd dates | 10pm | 288 min | 145% | 417 min 36 sec |

The heaviest modeled combination is about 760 zone-minutes, or about 380 minutes evenly split across two lanes. That suggests ample room in an ordinary overnight period, but fresh intentions will determine the real workload. These estimates use the vendor editor's budget calculation, not observed runtimes. Some reported program end times disagree with that calculation. Modeled overlaps around 4am on October 6 and October 8 are configuration warnings, not proof of three physically watering zones.

History probes returned empty arrays. This limits verification, but it does not contradict the owner's experience of reliable program execution. Ask Tucor whether history collection/upload is available; do not block the intent interface on it or require daily history polling.

Reported system capacity is zero, so it does not establish hydraulic protection. Controller clock interpretation, calendar mapping, and simultaneous program behavior still need validation. Tempest is configured and supplies sunrise and hourly temperature fields; the current weather adapter retains rain information only. Add sunrise or calculate it locally for the preview; defer hourly temperature support.

## Intent interface and watering records

Each zone intention contains a target duration, cadence, enabled state, and optional first due date. Store durations in seconds to preserve short runs such as the twenty-second Avalow cycle; expose minutes for ordinary entry and allow seconds where needed. Initially support every N local days and roughly N times per week. Leave explicit weekdays out unless actual use calls for them.

For twice weekly, alternate three-day and four-day intervals. Use local calendar dates rather than multiples of twenty-four hours. Seed intentions with a chosen first due date; the tested history endpoints provide no reliable last-watering date.

For the first preview, use a clear rain rule: a due run remains pending during a rain hold and moves to the first eligible night after the hold. Rain does not itself count as watering. The next interval starts from that watering's local date, and the three/four-day phase advances only then. Make this assumption visible in the preview so the owner can judge whether it matches the desired behavior before live operation.

Keep intentions separate from watering records. Record the planned duration and time, installation or start evidence, any completion evidence, and an outcome such as confirmed, assumed, partial, rain skipped, deferred, failed, or unknown.

Given the controller's observed reliability, an installed and verified controller schedule may count as **assumed watering** after its expected finish when no known rain hold, power outage, stop, or fault contradicts it. This advances the cadence and is labeled as assumed, not confirmed. It does not require a new controller read every morning. Detailed history, when available, or an explicit owner correction can replace the assumption. Preview-only plans never become watering records merely because their planned time has passed.

Known partial or failed runs do not count as full watering. A lost installation/start acknowledgement remains unknown until reconciled; do not blindly retry or replay it. Allow the owner to record a known watering, including a manual run that satisfied the intention. Defer elaborate automatic partial-run accounting until actual use demonstrates a need.

## Resolve intentions into a preview

Show a rolling fourteen-day projection. Future dates assume the projected watering occurs; rain and owner corrections can change them. Only the next night would be installed on the controller once live execution is enabled.

For each night, assign due zones to two sequential lanes with a simple longest-first greedy algorithm. Prefer overdue work when choosing what fits and keep ties stable. Work backwards from the preferred finish without starting before the earliest start; use the hard deadline when necessary.

Validate the candidate timeline, including midnight crossings. If it overflows, show which work is deferred and how many more minutes that candidate needs. Do not silently shorten durations or increase concurrency. The greater of the longest job and half the total duration provides a quick lower bound; a greedy failure alone is not proof that no arrangement can fit. Do not build a search engine or search-timeout reporting for this milestone.

The interface should make it easy to enter and adjust each zone's needs and see the consequences: watering dates, durations, lane timelines, next due dates, final finish, use of time after sunrise, and reasons for skips or deferrals. A per-zone list and simple timeline are sufficient. Controller program numbers belong in installation details.

## Preferred execution: compile the next night

If validation succeeds, compile the resolved night into two sequential Tucor programs, one per lane, with one start each and only the intended start date enabled in the fourteen-day calendar. Verify how calendar days apply to runs that cross midnight. Write and read back the configuration in a bounded session; then let Tucor run the night independently of 2core. Keep using the existing weather rain holds.

Validate the following before committing to this approach:

- Program step capacity and duration precision support the actual lane contents, including short runs. Explicit budgets produce the intended durations.
- Program writes can be read back reliably, and their connection/session cost is acceptable.
- Controller clock and calendar mapping produce the intended start times; two programs behave as two sequential lanes.
- Two simultaneous zones have acceptable pressure and coverage, and rain holds suppress the installed schedules as expected.

Two programs would avoid the ten-program bottleneck if their step capacity is sufficient. They bound scheduled concurrency only when legacy automatic starts are removed from the active schedule. Manual commands still need to check current activity before admitting another zone; another client can also affect capacity.

Program writes are not assumed transactional. Before live cutover, snapshot the legacy configuration and establish a verified update procedure that handles failure between lane writes. Do not claim that a partly installed night is ready.

If 2core fails after installation, that night's controller programs can still run, subject to power and rain holds. The fourteen-day calendar will repeat an unchanged night later; that is a stale schedule, not a complete recovery plan. Before live cutover, choose a simple, explicit response to missed refreshes and retain a restorable legacy configuration. Defer watchdogs, automatic mode switches, and a separate recovery compiler unless experience shows they are needed.

## Alternative: direct execution

If program compilation proves impractical, evaluate bounded direct zone timers using the same intentions and resolver. Account for the cloud contact required to start jobs and observe or reconcile their outcomes, including short cycles. This approach must justify its contact cost against the project's priorities, rather than merely fit under the rate limits.

Direct execution would need shared capacity admission for manual and scheduled work, durable command identity, and restart reconciliation. Do not build that scheduler before the execution choice is made. Tucor's reliable program execution is a reason to prefer letting the controller own the night.

## Next work

1. **Build the intent interface and preview.** Add local intent storage, a pure resolver, and a fourteen-day preview. Enter the owner's actual durations and cadences, inspect the result, and adjust it. Output remains advisory; existing controller schedules continue unchanged.
2. **Do the small controller checks alongside that work.** Arrange a supervised two-zone pressure/coverage test, test a program write and readback, validate clock/calendar semantics, and ask Tucor about history. These checks inform execution; they need not block the interface. Raising the manual limit to two can ship separately after validation, with admission based on current activity rather than changing a constant alone.
3. **Use the actual preview and controller results to choose execution.** Prefer nightly compilation if it works. Implement only the machinery the resulting schedule needs. Review the concrete schedule before a supervised, verified cutover with a restorable legacy snapshot.

Suggested initial boundaries are `server/intents.mjs` for cadence and `server/planner.mjs` for pure resolution, extending `store.mjs`, the weather adapter as needed, and the existing web app. Add `server/programs.mjs` if nightly compilation is selected, or a durable scheduler if direct execution is selected.

This is enough planning to begin. The next useful evidence is the owner's intentions entered into a working interface and the schedule they actually produce.
