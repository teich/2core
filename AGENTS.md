# AGENTS.md

Guidance for coding agents working on 2core. The README describes the product and its operation; this file is about changing the code.

2core is a self-hosted bridge for a Tucor irrigation controller. It has a Node server (no framework), a phone-first web app (plain ES modules, **no build step**) and pure planning logic shared by both. The only runtime dependency is `socket.io-client@2.5.0`, pinned on purpose to match Tucor's Engine.IO 3 protocol.

## Priorities and hard rules

When goals conflict, they rank in this order:

1. **Be a good citizen to Tucor's cloud.** The owner's account must not get banned. Contact Tucor only while someone is using the app, to run a command, or when automation has to write a rain delay. **Never add background polling.** Session and login limits, backoff and the persisted guard ledger (`server/live.mjs`) are safety features: don't loosen them. Check every new feature against this contact budget first.
2. **Interactive experience**: manual zone runs, Walk mode, clear status.
3. **Automation**: the weather-driven rain delay. The watering plan is advisory only.

Hard rules:

- **No automatic write retries.** A command whose outcome is unknown is reported as unknown; the person decides what to do. The web app never resends a tracked command.
- **Live writes are off by default** (`ALLOW_LIVE_CONTROL`). Demo mode never touches hardware. Don't change defaults that affect real irrigation.
- **The plan never reaches Tucor.** Intentions, night settings, rebalancing and the program compiler are local; the program output is a dry run.
- **Runs started outside 2core are never stopped by 2core**, and the UI never offers stop for them.
- **Tucor credentials stay on the server.** Never log URLs with tokens (WeatherFlow takes its token as a query parameter); use `redact()` in `lib/protocol.mjs`.
- **CSP forbids inline scripts and styles.** Set sizes and positions through `el.style` in JS (see the `data-fill`, `data-left` and `data-width` patterns), never with `style="…"` in markup.
- Don't add a bundler, framework or runtime dependency without asking.

## Commands

```sh
npm ci
npm run demo      # simulator on http://127.0.0.1:8787, access key 2core-demo
npm test          # node --test: unit, HTTP, and an end-to-end demo-server smoke test
npm run check     # tsc type check of JSDoc-typed JS (no emit)
npm run format    # prettier --write
npm run verify    # format:check + check + test; CI runs the same three
```

`DEMO_DELAY_MS=8000 npm run demo` makes the simulated controller slow, so waiting states show. Run one demo server at a time: they share `data/demo/2core.sqlite`, and a second server rewrites the first one's run ownership.

## Layout

```
lib/       Pure logic shared by server and browser (planner, plan feasibility,
           program compiler, Tucor protocol). Browsers load it from /lib/<file>.
server/    Node HTTP server and controller bridge
web/       The web app, served as-is
test/      node --test suites (*.test.mjs) and fixtures
tools/     CLI (tucor.mjs), deploy and secrets scripts
deploy/    Docker and Tailscale deployment docs
research/  Protocol research and design notes
```

### Server

- `index.mjs` wires everything from environment variables: store, driver (demo or live), engine, HTTP listeners, weather timer.
- `engine.mjs` (`Engine`) is the controller core. One command queue (`serial`) serializes every Tucor read and write. It also holds the latest observation and run ownership, builds `GET /api/state` (`state()`), handles idempotent commands (`submit`/`command`) and does start/stop/next/rain with their safety checks. It keeps one-line delegates to the modules below, so routes and tests use a single object.
- `plan-service.mjs`: watering intentions, reviewed plan edits (`editPreview` returns a token, `editApply` checks it), rebalance and the program dry run.
- `weather-policy.mjs`: automatic rain-delay decisions and station health. `weather.mjs` has the pure threshold evaluation.
- `preferences.mjs`: zone alias, notes, favorite, order and flagged-issue validation.
- `http.mjs`: authentication and headers, then two route tables. `LOCAL` holds plan routes, which are answered at once. `COMMANDS` holds queued routes, which need an `Idempotency-Key` and a deadline and are recorded as operations. New POST routes go in one of the two tables. Document them in `server/API.md`.
- `static.mjs` serves every file under `web/`, and `lib/*.mjs` at `/lib/`, without a registry. It also generates the service worker's shell list and cache version. **Adding a frontend file needs no registration anywhere.**
- `store.mjs` is SQLite (`node:sqlite`). Settings are JSON under keys such as `zone:<id>`, `intent:<id>`, `runs`, `rain`, `policy`, `planSettings`, `weatherReading` and `tucorGuard`. Use `store.transaction(fn)` for multi-key writes.
- `live.mjs` is the Tucor driver (sessions, limits, backoff). `demo.mjs` is the simulator with the same interface.
- `validation.mjs` has `AppError` (message shown to the person, with an HTTP status), `number()` and `LIMITS`.

### Web app (`web/`)

`index.html` holds all markup: views, dialogs and an icon sprite. `main.js` mounts everything. There is no framework. Views update existing elements by id, and polling re-renders about every 1.5 s.

```
core/app.js       `app`: the one shared session (server state + UI selections),
                  the view registry, render() and tick(), and a small event bus
core/commands.js  load(), act() and the command lifecycle (accepted → confirmed)
core/api.js       the only fetch() to /api
core/dom.js       $, $$, html(), escape(), icon(), pad()
core/format.js    time and duration text (pure)
core/message.js   the status banner
core/storage.js   localStorage conveniences (always optional)
model/*.js        pure logic: zone modes, blocked reasons, weather and plan text
views/*.js        one module per area: shell, zones, walk, zone-sheet,
                  findings, weather, activity, dock
plan/*.js         the Plan tab (state, draft, page, fit, zone/settings sheets, programs)
fx/*.js           WebGPU water effects (self-contained)
styles/*.css      linked in order from index.html; later sheets override earlier ones
```

Conventions:

- **Each view module exports `mount(deps)`**. It wires that view's events once and returns `{ render, tick }`. `render()` runs after any state or selection change. `tick(now)` runs every second for countdowns and may return a partial frame for the water effects (`vessel`, `tankState`, `capsule`). Registration order in `main.js` is render order.
- **Logic that decides something goes in `model/` as a pure function of `context()`** (from `core/app.js`), with a test in `test/web-model.test.mjs`. Views turn model results into DOM. Model and `core/format.js` must not touch `document`, so Node can run them.
- **Server calls go through `core/api.js`.** Controller commands go through `act()` in `core/commands.js`, which tracks the command until the server confirms it. Plan edits go through `plan/draft.js` (stage, check, save).
- Use `html(id, markup)` for lists that polling rebuilds. It skips unchanged markup and keeps focus. Escape every interpolated string with `escape()`.
- Prefer event delegation on a container with `data-*` attributes (`data-zone`, `data-walk`, `data-plan-zone` and so on) over per-item listeners.
- A view may import another view's `open…()` function, such as `openZone` or `openFlag`, to open its dialog. Shared state goes in `app` (or `plan` for the Plan tab), not in module globals that other modules read.
- `$`/`$$` are deliberately typed `any`. Add JSDoc types where they carry meaning: function parameters, state shapes, module contracts.

### Shared library (`lib/`)

Pure ES modules with no Node or browser APIs. That's what lets both sides import them. Browser modules import them by relative path (`../lib/planner.mjs`), which resolves to `/lib/planner.mjs` when served. Keep planning math here so the server's checks and the app's preview always agree.

## Making changes

- **Style**: Prettier (`npm run format`), 120 columns. Comments explain *why* and the non-obvious; skip what the code already says. Match the surrounding naming and idiom.
- **UI text**: short, plain sentences in the second person. Use typographic apostrophes and quotes (’ “ ”), and `·` as a separator. Say what happened and what the person can do. Never claim the controller did something it hasn't confirmed.
- **Tests**: add or update tests with every behaviour change. Server logic goes in `test/engine.test.mjs`, `test/async-commands.test.mjs` and the like. Planning goes in `test/planner.test.mjs` and `test/plan-feasibility.test.mjs`. Web logic goes in `test/web-model.test.mjs`. New end-to-end API flows go in `test/smoke.test.mjs`.
- **Verify UI changes in the running demo**, not just with tests. Run `npm run demo`, sign in, and exercise the flow. While a page is hidden the app pauses polling and ticks, and a background browser pane counts as hidden.
- **Docs**: update `server/API.md` when a route or payload changes, and the README feature list when behaviour visible to the owner changes.
- **Mechanical reformats** go in their own commit, listed in `.git-blame-ignore-revs`.
- Commit messages: an imperative summary line, then the why.
