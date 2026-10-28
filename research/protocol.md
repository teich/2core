# Tucor protocol notes — 2026-09-27

## Scope and evidence

Investigated the signed-in Tucor Cycle Manager Web Interface and its deployed
JavaScript/source maps. Public source maps provide original Vue components,
including login, device selection, station runtime controls, rain shutdown,
history, and status parsing. No local-controller probing was needed.

Source snapshots live in the ignored `assets/` and `source/` directories next to
this file. Hashes are recorded in `assets-manifest.json`. Main deployed bundle:
`https://tucor.mysrc.online/js/app.37eafea5.js`; its map is the same URL plus `.map`.
SSO bundle: `/sso/js/app.6605415d.js`, also with a source map. Tucor had
redeployed by 2026-10-23; the program-writing notes below come from that day's
bundle, `/js/app.cebfb023.js` and its chunks.

Evidence levels:

| Capability | Evidence |
| --- | --- |
| Browser login/logout | Verified using saved browser credentials |
| Password-to-token endpoint | Recovered from SSO source; browser login succeeded |
| Token validation and device enumeration | Verified independently by CLI |
| Socket connection, token login, controller selection | Verified independently by CLI |
| Live status | `Main`, `Stations`, `System`, `Alarms`, `Programs` messages received |
| Station inventory | Available from `Main.decoderList`; HTTP metadata endpoint also tested |
| History menu and program overview | Verified independently; six categories, empty program overview |
| Start/stop a station | Deployed UI payload; verified live (2026-09-27 onward) |
| Set/cancel rain shutdown | Exact deployed UI sequence recovered; used by 2core, no supervised live test recorded |
| Read programs | Pushed on controller selection; kept by 2core since 2026-10-07 |
| Write programs and sync | Messages recovered from the editor source (below); never sent |
| Direct local control | Not investigated in this session |

## Architecture and authentication

The browser talks to two services on the same HTTPS origin:

1. REST endpoints for auth, device inventory, history, and station metadata.
2. Socket.IO on its default `/socket.io/` path for controller sessions, status,
   and runtime actions. Engine.IO protocol is 3; Socket.IO parser protocol is 4.
   A Socket.IO 2.5.0 client successfully connected using HTTP polling. WebSocket
   upgrade is optional and was not needed for the verified read-only sample.

SSO (`research/source/sso/login.script.ts`) performs:

```http
POST /api/get-token
Content-Type: application/json

{"user":"<username>","password":"<password>"}
```

The response is a JSON string containing a token, or `"ACCESS DENIED"`.
The frontend stores a token in the `auth` cookie. It calls
`GET /api/validate-token?token=<token>&controllerID=null&typeName=null`, expects
`validatetoken`, sets `Authorization: bearer <token>` for REST, and sends this
Socket.IO event:

```json
{"category":"server","command":"login","data":{"token":"<token>"}}
```

Application packets use the Socket.IO event name **`message`**. The server sends
a `data/get` response with `data.item = "User"` and `data.record` on successful
login. A `server/login` response with `data.status = "BAD"` indicates rejection.
Some miscellaneous messages arrive as JSON strings; the useful status messages
observed arrived as objects.

The app's console logs a complete Axios response for the history menu, including
its authorization header. During research this allowed reuse of the current
session for same-service CLI tests without reading the saved password. The token
was kept in a permission-restricted, Git-ignored local file and removed afterward.
Avoid sharing raw console logs or HAR files.

## Controller discovery and session setup

```http
GET /api/authenticated/function/getdevicelistnew?controllerID=null&typeName=null
Authorization: bearer <token>
```

Response path: `getdevicelistnew[0].devicelist`. Relevant fields: `ctrlid`,
`description`, `typename`, `active`, `online`, `newstate`. The browser treats
`active > 0` as **Busy**. Do not assume `online` is a boolean: it was numeric
session/process-like data in this account.

Observed device: `ctrlid=2479`, `typename="ltd"`, description `5368 BV Garage`.
The 5368 portion is a location label, not the API ID.

```json
{"category":"server","command":"select","data":{"type":"device","item":2479,"typename":"ltd","controllerType":"LTD"}}
```

The frontend uses component lifecycle messages, not just resource URLs. The
verified CLI initializes `App` and `Login` with `Created`/`Mounted`, logs in,
selects the controller, sets route `/home`, initializes `Header` and `Home`,
and requests `Header/Refresh`. Omitting the root `App` lifecycle still yielded
`Main` but did not produce the expected `Stations` stream in initial tests.

```json
{"component":"App","command":"Created"}
{"component":"App","command":"Mounted"}
{"category":"route","data":"/home"}
{"component":"Header","command":"Refresh"}
```

These are individual `message` event payloads, not one multi-object JSON value.
Release a selected controller when done:

```json
{"category":"server","command":"deselect","data":{"type":"device","item":2479}}
```

Server codes observed: `I00` connecting, `I01` connected,
`I01:02` connected/not synchronized, `I20:720` twelve-minute session timeout.
The frontend can extend its session with `server/extendtime`; the CLI currently
uses a bounded one-shot sample instead of keeping a connection alive.

## Station control

From `src/components/StationComponent.vue` and `StationsSetTime.vue`:

```json
{"component":"Stations","command":"Start","id":"2","time":60}
{"component":"Stations","command":"AutoStatus","switch":"on"}
```

`id` is the scalar `StId`, ultimately the displayed station number; it is not the
database object ID, label, or decoder hardware address. Duration is seconds:
the UI converts hours/minutes to `3600*hours + 60*minutes`, capped at 17h59m.
The offline planner is scoped to this controller's 1–100 station slots.

Stop is different:

```json
{"component":"Stations","command":"Stop","handleID":[12345]}
```

Get the numeric handle from the station's `runningEntries[].handleID` after the
start is acknowledged. One station can have more than one running entry. Do not
substitute its station ID for a handle. Frontend code has both flat and nested
array stop paths; the single-entry flat numeric array above is used directly by
the individual-entry stop handler and is the initial integration target.

`Survey/Start` is a separate path with a 600-second default. It is unnecessary for
simple zone control, and the UI warns that a survey can stop other irrigation.

## Rain shutdown

From `src/components/RainShutDown.vue`, `Start()` first calls `Stop()`, waits one
second, then sends the start packet. For 24 hours:

```json
{"component":"Rainshutdown","command":"Stop"}
```

Wait 1000 ms, then:

```json
{"component":"Rainshutdown","command":"Start","runtime":86400}
```

The UI allows 1–999 whole hours (up to 41 days 15 hours) and only exposes this
control in Automatic mode. Cancel sends `Rainshutdown/Stop`. Actual device
acknowledgement and failure semantics still require a controlled test. Do not
blindly retry the stop/start pair: it changes the existing delay.

## Status and units

Status messages observed:

| Component | Useful data |
| --- | --- |
| `Main` | `controllerMode`, `rainShutDown`, `currentFlow`, `expectedFlow`, `systemCapacity`, `voltage`, `current`, `waterConsumption`, `decoderList`, `alarm` |
| `Stations` | Arrays of active-station entries; idle samples returned `[]` |
| `System` | `Capabilities`, including units/formatting (can be top-level, not under `data`) |
| `Alarms` | `data.alarm` |
| `Programs` | Program capabilities and program information |

`Main.decoderList` includes all station slots with `decid`, `oid`, `name`, and
`description`. It must not be confused with the running-station stream. In the
UI's station parser, later non-TWC updates only list active stations: previously
active entries absent from an update are stopped, while stored names and other
metadata are preserved.

Voltage divides by **100** (`3480` → 34.8 V). Current is mA. The observed units are
Imperial, flow GPM, water Gallons; check `System.Capabilities` for other devices.
`rainShutDown` is remaining seconds; `controllerMode=2` is Automatic. Raw values
can be strings. Water totals can be null (unknown), which must remain distinct
from measured zero. Do not infer a working flow meter from a zero flow value.

Controller time is a device-supplied epoch-like value rendered by the frontend
with special UTC formatting. It differed from wall-clock time during research;
the CLI preserves `controllerTimeRaw` and records its own UTC `receivedAt`.
Time-zone/clock behavior needs validation before schedule or time-range features.

## HTTP metadata and history

Authenticated metadata:

```http
GET /api/auth/decoders?controllerID=2479&typeName=ltd
```

The shared HTTP helper appends `controllerID` and lowercased `typeName` to normal
requests. History also has its own **group mapping**: `twc` for the TWC family,
otherwise `rkx`, including this LTD. `group=LTD` returned HTTP 422; `group=rkx`
worked.

```http
GET /api/history?group=rkx&controllerID=2479&typeName=ltd
GET /api/auth/history/program/overview?group=rkx&controllerID=2479&typeName=ltd
```

The first returns allowed categories/options; use those rather than guessed paths.

| Category | Options returned for this controller |
| --- | --- |
| `water` | `monthly`, `daily`, `hourly` |
| `intelliset` | `monthly`, `daily`, `hourly` |
| `moisture` | `overview`, `details`, `probe` |
| `errorandstatus` | No options; frontend repeats category as final path segment |
| `program` | `overview`, `detailed` |
| `rawInformation` | `operation`, `misting`, `waterusage`, `monalarms`, `intelliset`, `miscellaneous`, `all` |

Program overview returned `[]` in the authenticated CLI test. That validates the
request and empty response, not the availability of historical records. The
browser offers CSV export after data is loaded.

### Runtime history probe (2026-09-30)

Read-only probes against controller 2479 (LTD) returned HTTP 200 and `[]` for
`program/detailed` and `rawInformation/operation`, both before and during a
confirmed live controller session. During that session, `water/daily` and
`errorandstatus/errorandstatus` also returned empty arrays; `rawInformation/all`
returned HTTP 404 despite being advertised in the history menu.

The vendor History component defines program fields `station`, `start`, `stop`,
`runtime` (seconds), `status`, and `stopReason`. Raw operation fields include
station, timestamp, start/stop/pause/resume actions, and automatic/manual mode.
These schemas suggest per-station runtime collection is possible when populated,
but this account currently supplies no records through the tested endpoints.
Retention, incremental query support, and runtime treatment of pauses therefore
remain unverified. Empty history must not be interpreted as zero watering.

Responses were saved in the production data volume under
`/app/data/history-probes/2026-10-01T01-16-41-845Z/`. The probes used two guarded
password logins and one controller session, which was released afterward. No
watering, configuration synchronization, logging settings, or scheduled task
was changed. Confirm history collection/upload availability with Tucor before
implementing a daily runtime import.

## Programs (2026-10-07)

### Reading

Right after `I01` (controller connected), Tucor pushes two `Programs` packets
without being asked. First comes capabilities, with `Capabilities` at the top
level rather than under `data`:

```json
{"component":"Programs","type":"Capabilities","Capabilities":{
  "programMethod":["Sequential"],"name":{"enable":true,"maxLength":12},
  "booster":{"enable":true,"count":2},"wb":{"minimum":0,"maximum":250},
  "startTimes":{"maxStarts":12},"steps":{"maxStationsPerStep":1,...},
  "programTypes":[{"value":"0","label":"WB"},{"value":"4","label":"Weather"}],
  "allowPeriodChange":true,
  "periods":[{"value":0,"label":"14 days","editable":true},
             {"value":1,"label":"Odd","editable":false},
             {"value":2,"label":"Even","editable":false}]}}
```

Then `{"component":"Programs","data":[…]}` with all ten programs, repeated
several times during a session. An anonymized copy is in
`test/fixtures/tucor-programs.json`. Each program has these fields:

| Field | Meaning |
| --- | --- |
| `ID`, `name` | Slot 1–10; name padded to 12 characters |
| `status` | `"1"` on, `"0"` off |
| `waterBudget` | Percent applied to every step's runtime (0–250) |
| `irrigationType` | `"0"` water budget, `"4"` weather |
| `period` | `"0"` 14-day mask, `"1"` odd days, `"2"` even days |
| `fullDaySchedule` | 14 characters aligned with `allDaysArranged`, which starts on the day of the read (`WTFsSMt…` on a Wednesday; the fixture was captured on a Sunday): a letter waters that day, `-` doesn't. Odd and even programs report an approximate mask |
| `starts[]` | `startSeq`, `starttime` (minutes after midnight), `cycles`, `endtime` (reported finish in minutes, can exceed 1440, or `-1`) |
| `steps[]` | `runSeq`, `runtime` (seconds, before budget), `decoders` (station ids) |
| `runningStatus`, `runningEntries`, `nextRun`, `today` | Live state. `nextRun` was sometimes a small number and sometimes epoch ms |

Production reads on 2026-10-07 (Wednesday) and 2026-10-22 (Thursday) bear
this out: `allDaysArranged` began `W` and then `T`, and an unchanged 14-day
program's mask moved by one day, fifteen days later.

Three findings matter for writing programs:

- **Steps are fixed per station on this LTD.** With `maxStationsPerStep: 1`,
  `runSeq` equals the station id. A program runs its stations in station-number
  order and can't reorder them. The compiler's canonical zone-id ordering
  already matches.
- **The 14-day mask arrives in either week order.** Within one session, early
  packets and later ones reported the same programs with the two weeks
  swapped. Which half is the current week needs checking against `nextRun`
  or the controller before writing a calendar.
- **Steps can't be deleted.** Capabilities report `steps.deleteStep: false`,
  so the dry run removes a station from a program by writing a 0-second
  runtime. Nothing in the message family sets a program's name or lets a
  program water during a rain delay.

### Writing (recovered 2026-10-23, never sent)

Read from the current editor: `EditPrograms.vue` and its `EditProgramType`,
`EditProgramRunTimes`, `EditProgramStartTimes` and `EditProgramParameters`
steps, plus `pages/Programs.vue` and `SyncModal.vue`, in
`app.cebfb023.js.map`. Writes use an `Irrigation` message family, distinct
from the `component`/`command` messages used elsewhere. Every message goes
out with `socket.emit('message', …)`, like the rest of the app.

**Opening the editor.** Navigating sends `{category:'route', data:'/programs'}`.
The Programs page, the editor and each editor step send
`{component:'Programs', command:'Mounted'}` (the page also sends `Created`).
That request is how the editor reads programs back: Tucor answers with the
`Programs` packet, and the editor stays locked until a list of all ten
arrives. When a pushed packet carries `ProgramUpdate`, the editor sends
`Programs`/`Mounted` again to refresh.

| Change | Message |
| --- | --- |
| Type, status, budget, booster | `{Category:'Irrigation', Type:'IrrPgmData', Oper:'Upd', Seq:<program>, …}` with one of `IrrType`, `Status`, `Budget`, `Booster` (`0` for none) |
| Calendar | `Period` alone when the period changes; each day toggle then sends `Period` and `Weekdays` together. Days can only change on an editable period (the 14-day calendar here) |
| Start times | `{Category:'Irrigation', Type:'IrrPgmStart', Oper:'Upd', PgmId, Seq:<1–maxStarts>, Time, Cycles, EndTime}` for every slot, `Time:-1, Cycles:null, EndTime:null` for unused ones. `Time` is minutes after midnight; `EndTime` is `floor((start + runtime × cycles + soak × (cycles − 1)) / 60)` in minutes and can pass 1440 |
| Step runtime, one station per step | `{Category:'Irrigation', Type:'IrrPgmCont', Oper:'Upd', PgmId, Seq:<station id>, RunTime:<seconds>}`. Always `Upd`; removing a station writes `RunTime: 0` |
| Step runtime, grouped stations | `IrrPgmStep` with `StepNo`, `Station` and `Seq`, plus `IrrPgmCont` addressed by step. Not used on this controller |

`Weekdays` is built from `allDaysArranged`: the day's letter (`S M t W T F s`)
where it waters and `-` where it doesn't, in that order, starting with the
day of the read. That matches what Tucor reports in `fullDaySchedule`.

**Sync.** The program editor never sends `synchronize`, but its edits stay in
Tucor's cloud until someone syncs: Tucor requires the sync to be started by
hand (confirmed by the owner, and by the test below, where the status went to
`I01:02` and stayed). The sync is a separate dialog behind the header's
connection icon, which reads `I01:01` “Synced” or `I01:02` “Not Synced”.
From `SyncModal.vue`:

1. It opens with `{category:'data', command:'get', data:{type:'dataset',
   item:'TimeStamps'}}` and `{category:'server', command:'synchronize',
   data:{type:'initiate'}}`.
2. Tucor answers with `{component:'SyncModal', Capabilities:{sections,
   ctrlWarn}}` (`sections` maps a section id to its name) and a
   `TimeStamps` dataset whose `record` lists, per `sectionid`, change times
   and Tucor's proposal: `useappdata` `'1'` sends the app's values to the
   controller, `usectrldata` `'1'` takes the controller's, `warning` `'1'`
   flags a conflict. Later `TimeStamps` packets update one section each.
3. The person may change a section's direction (`{Category:'Settings',
   Type:'SyncDirection', Oper:'Upd', Seq:<section>, UseApp, UseCtrl}`, or
   `SelectAll`), then starts it with `{category:'server',
   command:'synchronize', data:{type:'execute'}}`. With `ctrlWarn` the
   dialog asks for confirmation first.
4. Progress arrives as `I23:<percent>`; it ends with `synchronize` status
   `OK` or `I01:01`. `E42:*`, `EF1:02` and `W24:*` are sync problems. The
   dialog also lists `IFE`, which Tucor sends on every connection.

A sync covers every section, so 2core runs it only when Tucor proposes the
app's programs and nothing else, and never changes a direction.

**Acknowledgements.** The editor doesn't wait for a reply to each message.
It shows “saving” on any `Upd`, refreshes on `ProgramUpdate`, and treats
the refreshed list as the result.

First test write, 2026-10-23: 17 messages to program 1; Tucor's readback
matched within seconds, the status went from `I01:01` to `I01:02` about six
seconds later and stayed there, and the controller kept its old program.
No packet carried `ProgramUpdate`; about 14 seconds after the writes Tucor
sent the capabilities and the program list again.

On 2026-10-28 the owner synced it by hand from Tucor's dialog, with only
Programs listed. The controller then showed exactly what was written: off,
zone 2 for one minute, 23:00, 100%, and Saturdays October 31 and November 7.
Those are the written days (October 24 and 31, from the day of the write)
carried forward on the 14-day cycle, so the controller reads `Weekdays` from
the day of the write. 2core's next read reported `I01:01` “Synced”.

While Tucor's own app had the controller selected, 2core's reads failed with
“controller busy” until every Tucor tab and app was closed. Still unknown:
the sync proposal's exact shape, which 2core's own sync step relies on.

Do not use the configuration synchronization modal as a connection repair tool.
No synchronization, edits to schedules, station setup, controller dial/mode
changes, surveys, or watering commands were issued during this research.

## Warm-session status reads (2026-09-27)

Production read-only probes found that `Stations/AutoStatus` with `switch:on`
selects station-only updates: sending it immediately after `Header/Refresh`
can prevent the awaited `Main` packet. The captured vendor `Header.vue` sends
`{component:"Header",command:"SetState",position:"Up"}` when opening its
status dashboard. Send that before a warm `Header/Refresh` to restore the full
`Main` + `Stations` stream. Repeated reads on one live session, including after
station-only mode, returned in approximately 3.2 seconds. Do not append
`Stations/AutoStatus` to a full-status read. Start/stop still use station-only
updates for confirmation; the next full-status read restores dashboard mode.

A production deploy on 2026-09-27 showed the same symptom on a **new** session:
login, controller selection and the first `Stations` packet arrived within
about 6 seconds, but `Main` never arrived within 20 seconds. Tucor appears to
keep the station-only mode across sessions. New sessions now send
`Header/SetState Up` before their first `Header/Refresh`.
