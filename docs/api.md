# VesselTwin integrations API (as used by the plugin)

This describes the VesselTwin integrations API as the plugin uses it today: the **pairing** and
**credential management** surface. Uploading readings is not available yet and is covered at the end.
All paths are relative to the API base URL (default `https://api.vesseltwin.io`).

Stability labels used below:

- **STABLE**: part of the platform envelope. Changes are additive only; a breaking change would be a
  new route version.
- **PENDING**: not available yet. It will be published (as JSON Schema, with a new contract version)
  before the plugin implements it. Do not guess these shapes.

The integration requires a paid (Pro) plan. `POST /v1/integrations/pairing/start` answers `503` when the integration is off for the account. On authenticated calls the two cases differ: a plan problem is `403` `integration_paused_plan`, and a feature-flag problem is `503` `integration_feature_unavailable`.

## Conventions (STABLE)

- JSON request and response bodies, `Content-Type: application/json`.
- Every request sends `User-Agent: signalk-vesseltwin/<version>` and `X-VesselTwin-Contract: <integer>`.
  The plugin's current contract is `1`.
- Pairing and credential responses carry `Cache-Control: no-store`.
- Error bodies for platform errors look like `{ "code": "integration_...", "message": "..." }`. Show
  users neutral copy of your own; never display `code` or `message` verbatim.
- Validation failures (malformed body) are `400` with `{ "message": "Validation failed", "errors": [...] }`.

## Pairing flow (STABLE)

Device-code flow in the style of RFC 8628. The device never sees the owner's login; the owner proves
ownership by typing the code in the web app.

```
plugin                         VesselTwin API                    owner (web app)
  |-- POST pairing/start ------->|                                    |
  |<-- deviceCode, userCode -----|                                    |
  | admin reads userCode + verificationUrl from GET /status (not the status line) |
  |                              |<-- types code, picks a boat, approves
  |-- POST pairing/token (every `interval` s) -->|                    |
  |<-- 400 {error:authorization_pending} ...      |                    |
  |<-- 200 {credential, ...}  (once) -------------|                    |
```

### `POST /v1/integrations/pairing/start`

No authentication. Rate limited per client.

Request (all fields required unless noted; unknown fields are rejected):

| Field             | Type     | Notes                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------------- |
| `provider`        | string   | `"signalk"`                                                                  |
| `clientName`      | string   | 1-80 chars, plugin name                                                      |
| `clientVersion`   | string   | 1-40 chars, plugin version                                                   |
| `contractVersion` | integer  | 1-1000; must not exceed the server's latest contract                         |
| `deviceLabel`     | string   | 1-120 chars, shown to the owner at approval                                  |
| `requestedScopes` | string[] | at least one of `meters:write`, `vessel-info:suggest`                        |
| `providerHints`   | object   | optional; SignalK accepts only `{ "signalkSelfUuid": string }` (1-100 chars) |

Text fields reject control and invisible formatting characters and are trimmed and NFC-normalized.

Response `200`:

```json
{
  "deviceCode": "<opaque secret, ~43 chars>",
  "userCode": "ABCD-EFGH",
  "verificationUrl": "https://vesseltwin.io/connect",
  "interval": 5,
  "expiresIn": 600
}
```

- `deviceCode` is a secret: keep it in memory only, never log it, send it only to `pairing/token`.
- `userCode` is 8 characters from an unambiguous alphabet (no `I`, `O`, `0`, `1`), displayed as
  `ABCD-EFGH`. Show it to the user; it is safe to display.
- `interval` is the minimum poll spacing in seconds; `expiresIn` is the lifetime in seconds (10 minutes).

The plugin does not trust these values blindly. It clamps `interval` to 1-60 s and `expiresIn` to at
most 1800 s (a non-positive `expiresIn` is invalid), and never sleeps past the code's remaining
lifetime. It also rejects a response whose `verificationUrl` is not `https:` (plain `http:` is
accepted only for `localhost`, `127.0.0.1` and `[::1]`), is longer than 300 characters or contains
control or invisible formatting characters (it keeps the normalized `new URL(v).href`), or whose
`userCode` is empty, longer than 32 characters or contains control or invisible formatting
characters. Such a response is treated as invalid and maps to "rejected" below.

Failures and how the plugin maps them to a pairing outcome (the user sees neutral copy, never the
code):

| Response                                                                                             | Outcome in the plugin         |
| ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| `503` (`integration_feature_unavailable`, or no `code` at all)                                       | unavailable, try again later  |
| `429`, with `Retry-After`                                                                            | busy, try again later         |
| `400` `integration_contract_unsupported`                                                             | update the plugin             |
| any other `400`, including `integration_scope_invalid` and a validation error without a `code`       | rejected, check for an update |
| a `200` whose body fails the checks above (unsafe `verificationUrl`, bad `userCode`, no `expiresIn`) | rejected, check for an update |
| other statuses, network errors, malformed bodies                                                     | unavailable                   |

`contract_unsupported` means `contractVersion` is higher than the server supports. A `503` is
recognised by its status alone; a missing or unknown `code` does not change the outcome.
Pairing is never retried automatically: the user starts it again.

### `POST /v1/integrations/pairing/token`

No authentication. Rate limited per client. Body: `{ "deviceCode": string }`.

Pending and terminal states are returned as **HTTP 400** with `{ "error": "<string>" }`:

| `error`                 | Meaning                                                   | Client action                       |
| ----------------------- | --------------------------------------------------------- | ----------------------------------- |
| `authorization_pending` | Owner has not approved yet                                | Wait `interval` seconds, poll again |
| `slow_down`             | Polled sooner than `interval`                             | Increase the interval by 5 s, retry |
| `expired_token`         | Code expired, already used, unknown, or no longer allowed | Stop; start a new pairing           |
| `access_denied`         | Denied (including too many wrong approval attempts)       | Stop; tell the user                 |

Unknown and already-used device codes deliberately look the same as expired ones. `expired_token` and
`access_denied` can also result from account checks made at approval time (for example if the
integration is not enabled for the account), so the plugin's copy for them stays neutral and does not
say why. A `429` or `5xx` while polling widens the interval by 5 s (never past 60 s) and honors
`Retry-After`. If `Retry-After` is longer than the code's remaining lifetime the plugin stops instead
of sleeping: `429` becomes "busy", `5xx` becomes "unavailable", and the user starts pairing again.

Success `200` (returned exactly once, then the pairing is consumed):

```json
{
  "credential": "vti_<43 url-safe chars>",
  "credentialId": "<uuid>",
  "scopes": ["meters:write"],
  "vesselLabel": "<boat name or null>",
  "provider": "signalk"
}
```

Timing: the pairing lives 10 minutes from `start`. After approval the plugin should still be polling;
if it is not running when the owner approves, the pairing simply expires and must be restarted.

## Credential (STABLE)

- Format: `vti_` followed by 43 URL-safe base64 characters. The prefix exists so secret scanners can
  find leaks. The server stores only a hash, so the plaintext is delivered **once** (at `pairing/token`,
  and again only by `credential/rotate`) and cannot be recovered.
- Bound to one boat and to the owner who approved it. Write-scoped only; it cannot read VesselTwin data.
- Bound to the API origin that issued it. The plugin records `apiOrigin` (scheme, host, port) in
  `credential.json` at pairing and sends the credential only to that origin. A stored credential with
  no origin, or one that differs from the configured API URL, is never sent anywhere; the plugin goes
  to `reauth_required` with no network call (the status line then says the API address changed since
  pairing, without showing any URL; a real 401 keeps the generic "no longer valid" copy). The HTTP client enforces this too: it sets
  `Authorization` only when the request URL's origin equals the recorded one, and refuses otherwise.
- Redirects are never followed (every request uses `redirect: 'error'`); a redirect is treated as a
  network error, so a credential cannot be bounced to another host.
- The device cannot revoke its own credential. Unpair only deletes the local file; the owner revokes
  the connection in VesselTwin.
- Use: `Authorization: Bearer vti_...` on every authenticated call, only in that header.
- Store it as `AGENTS.md` requires: `0600` file in the plugin data dir, never in settings.
- The owner can revoke it at any time in VesselTwin. It is also ended automatically when the account is
  locked or deleted, the boat is archived or changes owner, or it goes **180 days unused**. Polling
  `status` or any authenticated call that is merely paused (see 403/503 below) counts as use, so a
  device that keeps polling while paused is not expired.

## Authenticated calls (STABLE)

### `GET /v1/integrations/status`

Headers: `Authorization`, `X-VesselTwin-Contract`. The contract header is tolerated if missing or
outside the window here, so an outdated plugin can still learn it must update. Response `200`:

```json
{
  "provider": "signalk",
  "minContract": 1,
  "latestContract": 2,
  "pluginUpdateRecommended": true,
  "serverTime": "2026-01-01T00:00:00.000Z",
  "summary": { "channels": 0, "awaitingSetup": 0, "held": 0 }
}
```

The example is what a contract-1 plugin receives from the current server (contracts 1 and 2 are
accepted, 2 is the latest), so the update hint is expected until the plugin moves to contract 2.

`pluginUpdateRecommended` is true when the plugin's contract is below `latestContract` (or missing).
`serverTime` can be used to warn about clock skew. `summary` is provider-specific (a small object of counts for this provider) and may be `null`; the plugin ignores it.
Unknown fields are ignored.

#### Status probe (how the plugin uses it)

The plugin is the only caller of this route. It sends no boat data; the request carries only the
credential and the contract header.

Cadence: once when the plugin starts with a stored credential, once right after pairing succeeds, then
about hourly (60 minutes with +-10% jitter). Probes never overlap. After a transient failure it backs
off (5 s up to 30 min, full jitter) and never probes sooner than `Retry-After`. A paused integration is
probed no more often than hourly.

Outcome table (`src/status.ts`):

| Response                                                                                                                          | State shown       | Next probe                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| `200`, plugin contract within `minContract`; update if `latestContract` is higher or `pluginUpdateRecommended`                    | `connected`       | hourly, with jitter                   |
| `200` with `minContract` above the plugin's contract                                                                              | `update_required` | hourly (an updated plugin would pass) |
| `200` body that is not this provider's status (`provider` is not `signalk`, or `minContract` / `latestContract` are not integers) | `offline`         | backoff                               |
| `401`                                                                                                                             | `reauth_required` | none (see below)                      |
| `426`, or `400` with a `integration_contract_*` code                                                                              | `update_required` | none                                  |
| `503` `integration_feature_unavailable`                                                                                           | `paused`          | `Retry-After`, at least 1 hour        |
| `403` `integration_paused_plan`                                                                                                   | `paused`          | `Retry-After`, at least 1 hour        |
| `403` `integration_scope`                                                                                                         | `update_required` | none (a plugin bug; same remedy)      |
| `429`, `5xx`, network error, timeout, anything else                                                                               | `offline`         | backoff, at least `Retry-After`       |

If the server clock and the device clock differ by more than 5 minutes, the `connected` status line
adds a note to check the date and time. A `connected` response also sets "a plugin update is
available" when `pluginUpdateRecommended` is true or `latestContract` exceeds the plugin's contract.

Any `401` stops all authenticated calls and moves to `reauth_required`; the plugin tells the user to
pair again. It does not loop. Only a `401` whose body has `code: "integration_unauthorized"` is the
platform's verdict on the credential; then the plugin also replaces `credential.json` (atomically,
same `0600` path) with a tombstone, `{ "reauthRequired": true, "vesselLabel", "apiOrigin", "pairedAt" }`, which
holds no credential and no credential id. A restart over a tombstone starts in `reauth_required`
and makes **no** network call. `POST /pair` is allowed and overwrites the tombstone; `POST /unpair`
deletes it. If the tombstone cannot be written the failure is logged and the old file stays, so a
restart would probe once more and get the same 401. A `401` with any other body (a proxy, a captive
portal) enters `reauth_required` and stops probing but leaves `credential.json` untouched, so a
restart probes once more.

### `POST /v1/integrations/credential/rotate`

**Server capability; this plugin version does not call it.** Documented for completeness.

Empty body. Same headers. Response `200` (plaintext shown once):

```json
{
  "credential": "vti_...",
  "credentialId": "<uuid>",
  "provider": "signalk",
  "scopes": ["meters:write"],
  "previousExpiresAt": "2026-01-01T00:10:00.000Z"
}
```

- The new credential belongs to the same installation and boat. The **calling** credential keeps
  working for 10 minutes (`previousExpiresAt`), then stops.
- Single shot: a credential can be rotated once. Calling rotate with an already-replaced credential
  returns `409` `integration_credential_superseded`. The replacement's plaintext cannot be fetched
  again, so the plugin must pair again.
- Persist the new credential durably (atomic write) **before** discarding the old one, and swap only
  after the write succeeds. If the process dies between the response and the write, the old key still
  works for the grace window.
- If the old credential is already revoked or the boat/account is gone, rotate returns the neutral 401.

## Guard errors the client must handle (STABLE)

Authenticated routes can answer with the following. The order shown is not a guarantee.

| Status | `code`                             | Meaning                                                                         | Client action                                                                                                                                                                                                                                   |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `integration_unauthorized`         | Neutral: bad, revoked, expired, idle, or the boat/account is gone               | Stop all authenticated calls, replace the credential file with a secret-free tombstone, state `reauth_required`; re-pairing overwrites it. (A 401 without this `code` stops calls but keeps the file.) Response has `WWW-Authenticate: Bearer`. |
| 403    | `integration_paused_plan`          | Integration paused for the account                                              | Keep the queue, probe hourly, resume when it clears                                                                                                                                                                                             |
| 503    | `integration_feature_unavailable`  | Not enabled for the account right now                                           | Keep the queue, honor `Retry-After` (hours), probe                                                                                                                                                                                              |
| 426    | `integration_contract_unsupported` | Contract outside the supported window; body has `minContract`, `latestContract` | Stop uploading, keep the queue, ask the user to update the plugin                                                                                                                                                                               |
| 400    | `integration_contract_required`    | Contract header missing or malformed (same extra fields)                        | Treat as a plugin bug; stop and surface it                                                                                                                                                                                                      |
| 403    | `integration_scope`                | Credential lacks the scope the route needs                                      | Stop that call; do not retry                                                                                                                                                                                                                    |
| 429    | `integration_rate_limited`         | Over the rate limit                                                             | Wait at least `Retry-After` seconds, then back off                                                                                                                                                                                              |

The 426 and the contract `400` come only from routes that enforce the contract header. The status
route does not (it tolerates a missing or old header so an outdated plugin can learn it must update),
so there they only show up as a `200` with `minContract` above the plugin's contract. The plugin treats
them the same wherever they appear: stop, keep the queue, say "update the plugin", and never guess a
different contract number.

The 401 is intentionally identical for every credential problem so it cannot be used to probe state.
Every 401, 403 and 429 above is an authenticated verdict about the credential; 5xx and network failures
are transient: back off with jitter.

## Plugin router (local, not part of the VesselTwin API)

The plugin registers three routes on the SignalK server, at `/plugins/signalk-vesseltwin`. They sit
behind the server's own admin authentication (a fresh server has security on; send an admin bearer
token). Admin-only is the server default for plugin routes, verified on signalk-server 2.33; the
plugin never calls `router.access` to relax it. A request with a browser `Origin` that differs from `Host` gets `403 { "error": ... }`, unless
the browser also sends `Sec-Fetch-Site: same-origin` or `none` (this covers a reverse proxy that
rewrites `Host`); `Origin: null` or an unparsable `Origin` is always refused. A request without
`Origin` (curl, scripts) is allowed.

| Route               | Response                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /status`       | `200` with the object below; `503` if the plugin is not running                                                                                                                                                                                                                                                 |
| `POST /pair`        | `202 { "started": true }`; `409` when already paired and working (or still checking); `503` if the plugin is not running or has a config error                                                                                                                                                                  |
| `POST /pair/cancel` | `200 { "cancelled": true }` for a pairing waiting for approval (including just after `POST /pair`, before the code exists); `409 { "error": ... }` when none is pending, including while an approved credential is being saved; `503` if not running. Never touches the stored credential or the re-pair marker |
| `POST /unpair`      | `200 { "paired": false, "message": ... }` after deleting the local credential; `503` if not running; `500` if it cannot be deleted                                                                                                                                                                              |

`GET /status`:

```json
{
  "state": "connected",
  "paired": true,
  "vesselLabel": "Boat name or null",
  "apiOrigin": "https://api.vesseltwin.io",
  "pairing": null,
  "updateRecommended": false,
  "clockSkewWarning": false,
  "lastCheckedAt": "2026-01-01T00:00:00.000Z",
  "message": "Paired with Boat name. Data upload is not available in this version."
}
```

- `state` is one of `not_paired`, `pairing`, `pairing_failed`, `checking`, `connected`, `paused`,
  `offline`, `update_required`, `reauth_required`, `config_error`.
- `paired` is true only while the stored credential is believed to work (false in
  `reauth_required`).
- `pairing` is `{ "userCode", "verificationUrl", "expiresAt", "expiresInSeconds" }` in state `pairing`
  (`expiresInSeconds` is the whole seconds left when the response is made, never negative; the web page
  counts down from it instead of comparing clocks), and
  `{ "reason": "expired" | "denied" | "unavailable" | "busy" | "update_required" | "rejected" | "local_failure" }` in
  `pairing_failed`; otherwise `null`. The user code is shown here only while pairing is pending.
  The plugin status line never contains it: SignalK broadcasts the status line to read-only and
  anonymous clients, while this route is admin-only.
- `message` is the same text as the plugin's status line. While pairing it is `Pairing in progress. Open VesselTwin under Webapps, signed in as an
administrator, to see the code.` `vesselLabel` comes from the server and is
  shortened and stripped of control characters.
- `POST /pair` answers 503 until the stored credential has loaded (right after the plugin starts), and
  is allowed in `not_paired`, `pairing_failed` and `reauth_required`. It does nothing
  new while a pairing is already pending.
- Pairing is bound to the plugin's lifetime: stopping or unpairing cancels it and forgets the code.

### Configuration errors

The `apiBaseUrl` setting must be `https://`, or `http://` for `localhost`, `127.0.0.1` or `[::1]`, with
no credentials, query or fragment. A set value that is not valid is a configuration error: state `config_error`, a status line asking the user
to fix the URL, `503` on `POST /pair`, and **no network calls**. The plugin never falls back to the
production URL for a non-blank invalid value. An absent, null, empty or whitespace-only value uses the
default.

## Rate limits

Authenticated calls are rate limited per credential. A plugin that batches, makes one request at a
time and honors `Retry-After` will not get close to the limits.

## What the plugin must never send (STABLE rule)

Position, tracks, MMSI, callsign, AIS data, crew or owner names, free text, or any identifier beyond
the documented pairing fields. The server rejects such fields, but the plugin must not read them in the
first place. See the privacy section of the README.

## Ingest (not built yet)

Uploading readings (batches of engine hours, battery and tank values), per-item result codes,
vessel-info suggestions and the idempotency rules are defined by the platform under a newer contract
version than this plugin's `CONTRACT_VERSION`. The plugin does not implement or call them yet: the ingest
JSON Schema still has to be vendored into this repo with a contract test, and upload work has to be
started explicitly by the owner. Until then the plugin reports that upload is not available. Do not infer
shapes from the pairing types above.
