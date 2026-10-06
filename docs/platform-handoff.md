# Platform contract the plugin depends on

This describes the VesselTwin integrations API as the plugin uses it today: the **pairing** and
**credential management** surface. Ingest (uploading readings) is a separate milestone and is covered
at the end. All paths are relative to the API base URL (default `https://api.vesseltwin.io`).

Stability labels used below:

- **STABLE**: part of the platform envelope. Changes are additive only; a breaking change would be a
  new route version.
- **PENDING**: not available yet. It will be published (as JSON Schema, with a new contract version)
  before the plugin implements it. Do not guess these shapes.

A paid VesselTwin plan is required, and the integration may not be enabled for every account yet.

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
  | show userCode + verificationUrl in the plugin status              |
  |                              |<-- types code, picks a boat, approves
  |-- POST pairing/token (every `interval` s) -->|                    |
  |<-- 400 {error:authorization_pending} ...      |                    |
  |<-- 200 {credential, ...}  (once) -------------|                    |
```

### `POST /v1/integrations/pairing/start`

No authentication. Limited per client IP (about 10 requests per minute).

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

Failures: `503` `integration_feature_unavailable` with `Retry-After` (seconds) when the integration is
not available; `400` `integration_scope_invalid` (a requested scope is not supported);
`400` `integration_contract_unsupported` (`contractVersion` is higher than the server supports);
`400` validation errors; `429` when throttled.

### `POST /v1/integrations/pairing/token`

No authentication. Limited per client IP (about 60 requests per minute). Body: `{ "deviceCode": string }`.

Pending and terminal states are returned as **HTTP 400** with `{ "error": "<string>" }`:

| `error`                 | Meaning                                                   | Client action                       |
| ----------------------- | --------------------------------------------------------- | ----------------------------------- |
| `authorization_pending` | Owner has not approved yet                                | Wait `interval` seconds, poll again |
| `slow_down`             | Polled sooner than `interval` (server paces to 5 s)       | Increase the interval by 5 s, retry |
| `expired_token`         | Code expired, already used, unknown, or no longer allowed | Stop; start a new pairing           |
| `access_denied`         | Denied (including too many wrong approval attempts)       | Stop; tell the user                 |

Unknown and already-used device codes deliberately look the same as expired ones.

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
- Use: `Authorization: Bearer vti_...` on every authenticated call, only in that header.
- Store it as the README and `AGENTS.md` (also readable as `CLAUDE.md`) require: `0600` file in the plugin data dir, never in settings.
- The owner can revoke it at any time in VesselTwin. It is also ended automatically when the account is
  locked or deleted, the boat is archived or changes owner, or it goes **180 days unused**. Polling
  `status` or any authenticated call that is merely paused (see 403/503 below) counts as use, so a
  device that keeps polling through a plan pause is not expired.

## Authenticated calls (STABLE)

### `GET /v1/integrations/status`

Headers: `Authorization`, `X-VesselTwin-Contract`. The contract header is tolerated if missing or
outside the window here, so an outdated plugin can still learn it must update. Response `200`:

```json
{
  "provider": "signalk",
  "minContract": 1,
  "latestContract": 1,
  "pluginUpdateRecommended": false,
  "serverTime": "2026-01-01T00:00:00.000Z",
  "summary": null
}
```

`pluginUpdateRecommended` is true when the plugin's contract is below `latestContract` (or missing).
`serverTime` can be used to warn about clock skew. `summary` is provider-specific and may be `null`.

### `POST /v1/integrations/credential/rotate`

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

Authenticated routes check, in order: the credential, the boat and owner, the account, availability,
plan, contract version, scope, and rate limit. Resulting responses:

| Status | `code`                             | Meaning                                                                         | Client action                                                                                     |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 401    | `integration_unauthorized`         | Neutral: bad, revoked, expired, idle, or the boat/account is gone               | Stop. Clear the credential, tell the user to pair again. Response has `WWW-Authenticate: Bearer`. |
| 403    | `integration_paused_plan`          | Account's plan does not currently include it                                    | Keep the queue, probe hourly, resume when it clears                                               |
| 503    | `integration_feature_unavailable`  | Not enabled for the account right now                                           | Keep the queue, honor `Retry-After` (hours), probe                                                |
| 426    | `integration_contract_unsupported` | Contract outside the supported window; body has `minContract`, `latestContract` | Stop uploading, keep the queue, ask the user to update the plugin                                 |
| 400    | `integration_contract_required`    | Contract header missing or malformed (same extra fields)                        | Treat as a plugin bug; stop and surface it                                                        |
| 403    | `integration_scope`                | Credential lacks the scope the route needs                                      | Stop that call; do not retry                                                                      |
| 429    | `integration_rate_limited`         | Over the rate limit                                                             | Wait at least `Retry-After` seconds, then back off                                                |

The 401 is intentionally identical for every credential problem so it cannot be used to probe state.
Every 401, 403 and 429 above is an authenticated verdict about the credential; 5xx and network failures
are transient: back off with jitter.

## Rate limits (STABLE, plain terms)

Limits are per credential, not per IP, as a token bucket refilled continuously.

- Ingest class (readings, when available): 60 requests per minute, up to 500 items per request.
- Management class (`status`, `credential/rotate`): 30 requests per minute.
- Pairing (`start`, `token`) has separate, per-IP limits as noted above.

A plugin that batches, single-flights requests and honors `Retry-After` will never get close.

## What the plugin must never send (STABLE rule)

Position, tracks, MMSI, callsign, AIS data, crew or owner names, free text, or any identifier beyond
the documented pairing fields. The server rejects such fields, but the plugin must not read them in the
first place. See the privacy section of the README.

## Ingest (PENDING, not available)

Routes for uploading readings (batches of engine hours, battery and tank values), their request and
response shapes, per-item result codes, vessel-info suggestions, and the idempotency rules are **not
published**. They will ship as JSON Schema attached to a release, together with a new contract version.
Until then the plugin does not call them, and reports that upload is not available. Do not infer
shapes from the pairing types above.
