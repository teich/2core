# Tucor protocol notes — 2026-09-27

## Scope and evidence

Investigated the signed-in Tucor Cycle Manager Web Interface and its deployed
JavaScript/source maps. Public source maps provide original Vue components,
including login, device selection, station runtime controls, rain shutdown,
history, and status parsing. No local-controller probing was needed.

Source snapshots live in the ignored `assets/` and `source/` directories next to
this file. Hashes are recorded in `assets-manifest.json`. Main deployed bundle:
`https://tucor.mysrc.online/js/app.37eafea5.js`; its map is the same URL plus `.map`.
SSO bundle: `/sso/js/app.6605415d.js`, also with a source map.

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
| Start/stop a station | Exact deployed UI payload recovered; not sent |
| Set/cancel rain shutdown | Exact deployed UI sequence recovered; not sent |
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

## Next validation

1. Pick an existing zone and a short supervised duration.
2. Read status first and ensure no competing automatic run.
3. Start once, observe the new running handle and countdown, then stop that handle.
4. Confirm both the reported state and physical watering stop.
5. Separately test rain delay and verify its remaining time, then restore the
   prior state. Resolve token expiry/reconnection semantics before unattended use.

Do not use the configuration synchronization modal as a connection repair tool.
No synchronization, edits to schedules, station setup, controller dial/mode
changes, surveys, or watering commands were issued during this research.
