# First implementation validation — 2026-09-27

## Completed

- 18 Node tests pass: recovered command shapes/status decoding, authentication, overlapping starts, duplicate requests, persistence across restart, uncertain outcomes, deadlines, unknown status rejection, owned-run stop, and rain-policy preservation.
- 14 Python tests pass with Home Assistant **2026.9.4**. This includes real HA config/options flow execution, entity platforms, services, unload, weather-unit normalization, and one end-to-end test against a separate Docker simulator.
- End-to-end: native HA timed-run action → HTTP → Docker → simulated zone start and stop. A `0.1 in/h` simulated Tempest observation was converted to `2.54 mm/h` and triggered a 12-hour weather hold. The test cleaned up its simulated run, hold, and mode.
- Docker image built with Node 24. Non-root operation, read-only root filesystem, writable SQLite volume, and Compose configurations checked.
- Browser checks at desktop and 390px phone width: access-key login, five-minute zone run/countdown, stop-and-next-zone transition, explicit stop, 24-hour rain delay and clear. No browser console warnings/errors observed during those checks.
- Phone and desktop screenshots saved locally in ignored `captures/2core-mobile.png` and `captures/2core-desktop.png`.

## Scope of evidence

Simulation validates our software behavior, not valve operation. The first protocol investigation verified live login, inventory, status, and history reads. The new server's physical write paths remain based on source-map research and have not been run against the irrigation hardware. No live watering, controller configuration, schedule, or rain-delay change was made during this implementation.

The integration has not been installed on the user's actual HA instance or deployed to the Proxmox server. Tempest entity selection is deferred as requested. Use the supervised sequence in `deploy/README.md` before enabling live control or automatic weather delays.

## Known limits

- Tucor cloud dependency; temporary exclusive selection can conflict with an open vendor UI.
- Observed API acknowledgements require hardware validation, especially running-entry handles, automatic expiry, and rain-shutdown timer semantics.
- Rain replacement follows vendor Stop → 1-second wait → Start. It is not atomic; a network failure between commands can clear a hold without replacing it.
- Only app-owned runs can be stopped here. An unacknowledged start may require the vendor UI to stop.
- Estimates for owned-run countdowns use the app's clock; observed controller activity determines completion.
- No manual test start during a rain hold, no configuration synchronization, no station/program editing, and no historical charts yet.
- Legacy Socket.IO dependency audit: three moderate entries from the `parseuri` ReDoS advisory. The cloud origin is fixed, but dependency modernization still needs protocol compatibility testing.


## Latency and phone-lock follow-up — 2026-09-27

- 42 Node tests and 13 HA tests pass; the optional Docker/HA end-to-end test was skipped in this run. New coverage includes durable HTTP acceptance, client-independent completion, duplicate requests, restart uncertainty, queue expiry, refresh coalescing/priority, shared sessions, real receipt timestamps, stale status, disconnect after send, warm stream restoration, idle/lifetime expiry, and the deadline between rain Stop and Start.
- A slow browser simulator confirmed that start and stop-and-next immediately show acceptance, survive page reload while pending, and finish without a follow-up request from the browser. Production Tailscale UI shows real inventory and confirmed activity without a Tucor login prompt.
- Deployed release `20260928T011349Z-21591`. Live probes identified that `Stations/AutoStatus` suppresses full `Main` updates; the vendor `Header/SetState` dashboard-open message restores them. The driver and fake-cloud regression fixture now model that behavior.
- Authorized live zone-02 one-minute test: HTTP acceptance 6 ms; Start dispatch 2 ms after recorded acceptance; running-handle confirmation 9.778 s. Handle 37 belonged to zone 2. A subsequent fresh read confirmed automatic expiry, ownership removal, and no running zones. Explicit live stop/next and rain-delay changes were not exercised in this follow-up.
- Warm full-status reads took 1.920–3.339 s in these samples, including a 2.487 s read confirming expiry. Measurements are inside the deployed container and do not include phone networking. Cold connection and controller confirmation can still take seconds; the phone no longer waits for those to acknowledge acceptance.
