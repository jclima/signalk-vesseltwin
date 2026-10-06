# Local smoke-test rig

Test use only. Nothing here is published to npm (the package `files` list excludes `dev/`).

The rig runs a stock signalk-server with the built plugin mounted, plus a mock VesselTwin API. It
covers pairing, the device status call and credential rotation. There is no upload surface.

## Track A: mock API

Needs Docker and Node >= 22.

```sh
pnpm build
docker compose -f dev/docker-compose.yml up -d --build
node dev/setup-signalk.mjs      # creates a throwaway dev admin, enables the plugin, sets apiBaseUrl
node dev/pair.mjs               # starts pairing, approves it on the mock, waits for the first status check
docker compose -f dev/docker-compose.yml down -v
```

- SignalK admin UI: <http://localhost:3100> (override with `SK_PORT`). Dev login: `dev-admin` /
  `dev-admin-password` (fake, override with `SK_ADMIN_USER` / `SK_ADMIN_PASSWORD`).
- Mock API: <http://localhost:3001> (override the host port with `MOCK_HOST_PORT`).
- The compose project is named `vesseltwin-dev`; set `COMPOSE_PROJECT_NAME` to run a second copy.
- Rebuild the plugin with `pnpm build` and run `docker compose -f dev/docker-compose.yml restart signalk`
  to pick up code changes.

The plugin only accepts `http` for `localhost`, so its `apiBaseUrl` is `http://localhost:3001`. A
`relay` container shares the signalk container's network and forwards its port 3001 to the mock. To
reach an API on your host instead, set `RELAY_TARGET=host.docker.internal:3001` (and stop the mock or
change `MOCK_HOST_PORT` so the ports do not clash), then recreate with `up -d`. Use `node dev/pair.mjs
--no-approve` and approve the code in that API's web app.

## Mock behaviour

Routes under `/v1/integrations`:

| Route                    | Notes                                                                         |
| ------------------------ | ----------------------------------------------------------------------------- |
| `POST pairing/start`     | Validates the body strictly; returns device code and `ABCD-EFGH` user code    |
| `POST pairing/token`     | `authorization_pending`, `slow_down`, `expired_token`, `access_denied` as 400 |
| `GET status`             | Needs `Bearer vti_` plus 43 URL-safe characters from a paired credential      |
| `POST credential/rotate` | Returns a new credential; the old one works for 10 more minutes               |

Contract header: pairing routes do not require it (the platform checks `contractVersion` in the body).
`status` and `credential/rotate` tolerate a missing or old header, as the platform does; the mock
records the header and whether `User-Agent` was present in its log.

## Plugin routes the scripts use

All under `/plugins/signalk-vesseltwin` on the SignalK server and all need the admin token:

- `POST /pair` starts pairing (202). `GET /status` returns:

```json
{
  "state": "pairing",
  "paired": false,
  "vesselLabel": null,
  "apiOrigin": "http://localhost:3001",
  "pairing": {
    "userCode": "ABCD-EFGH",
    "verificationUrl": "http://localhost:3001/connect",
    "expiresAt": "2026-01-01T00:10:00.000Z"
  },
  "updateRecommended": false,
  "clockSkewWarning": false,
  "lastCheckedAt": null,
  "message": "Enter code ABCD-EFGH at http://localhost:3001/connect"
}
```

- `pairing` is set only in state `pairing` (and is `{ "reason": ... }` in `pairing_failed`), otherwise
  `null`. Other states: `not_paired`, `checking`, `connected`, `paused`, `offline`,
  `update_required`, `reauth_required`, `config_error`.
- `POST /unpair` deletes the local credential (see [docs/TESTING.md](../docs/TESTING.md)).

`dev/pair.mjs` prints the status JSON (secret-looking keys masked) and exits 0 once pairing finished
and the first status check returned a state other than `checking`.

Env for the mock (compose passes these through): `MOCK_POLL_INTERVAL_S` (5),
`MOCK_AUTO_APPROVE_AFTER_POLLS` (0 = manual approve).

### Debug endpoints (`/__mock/*`, not part of the platform)

```sh
# approve the pending pairing (userCode optional: defaults to the newest pending one)
curl -X POST localhost:3001/__mock/approve -H 'content-type: application/json' -d '{"userCode":"ABCD-EFGH"}'
# deny it instead
curl -X POST localhost:3001/__mock/approve -H 'content-type: application/json' -d '{"deny":true}'
# request log: method, path, status, timestamp, whether auth was present. Never any codes or credentials.
curl localhost:3001/__mock/log
# clear all state (pairings, credentials, faults, log)
curl -X POST localhost:3001/__mock/reset
```

### Fault injection

`POST /__mock/fault` with JSON:

| Field                           | Meaning                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `route`                         | `pairing/start`, `pairing/token`, `status`, `credential/rotate`, `*` (all), or `clear`   |
| `status`                        | HTTP status to answer with                                                               |
| `code`                          | Optional error code; defaults per status (see below)                                     |
| `retryAfter`                    | Optional `Retry-After` seconds (503 defaults to 3600)                                    |
| `minContract`, `latestContract` | Optional contract window in the body; for `status` with `status: 200` it is the response |
| `once`                          | `true` = applies to one request, then clears                                             |
| `append`                        | `true` = queue after existing faults for that route instead of replacing them            |

Default codes: 401 `integration_unauthorized`, 403 `integration_paused_plan`, 426
`integration_contract_unsupported`, 429 `integration_rate_limited`, 503
`integration_feature_unavailable`. Examples:

```sh
f() { curl -s -X POST localhost:3001/__mock/fault -H 'content-type: application/json' -d "$1"; echo; }
f '{"route":"pairing/start","status":503,"retryAfter":30}'              # not available, with Retry-After
f '{"route":"status","status":401}'                                       # force a re-pair
f '{"route":"status","status":403}'                                       # paused plan
f '{"route":"status","status":426,"minContract":2}'                       # contract outside the window
f '{"route":"pairing/token","status":429,"retryAfter":10,"once":true}'    # throttled once
f '{"route":"status","status":200,"minContract":2}'                       # window moved up, plugin should recommend update
f '{"route":"clear"}'
```

The plugin checks status once on start and then about hourly, so to trigger a probe right after
injecting a fault, restart the plugin (see docs/TESTING.md).

The mock holds everything in memory; restarting it forgets paired credentials (the plugin's stored
credential then gets a 401 from `status`, which is a handy re-pair test).
