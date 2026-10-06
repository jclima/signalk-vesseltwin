# CLAUDE.md

Guidance for AI agents and contributors working in this repository (Claude Code, Codex, Kiro, others;
`AGENTS.md` is a symlink to this file). It stays lean on purpose: always-needed invariants only.
Volatile detail lives in the code (`ls src test`), `README.md`, and `docs/platform-handoff.md`.

## What this is

`signalk-vesseltwin` is a public, Apache-2.0 [SignalK](https://signalk.org) server plugin that pairs a
boat's SignalK server with VesselTwin (the owner approves a device code in the VesselTwin web app) and,
in a later release, uploads engine hours, battery readings and tank levels to the boat's maintenance
record. Status: pre-release `0.0.0`. Pairing and credential handling work; **uploading is not built**
and the plugin must say so honestly (status line: "Data upload is not available in this version").

## Commands

Node >= 22 (`.nvmrc` = 22; CI runs 22 and 24), pnpm 10 (`packageManager` in `package.json`).

```sh
pnpm install
pnpm lint          # eslint . && prettier --check .  (markdown included)
pnpm typecheck     # tsc --noEmit over src + test
pnpm test          # vitest run
pnpm build         # rm -rf plugin && tsc -> plugin/ (gitignored)
npm pack --dry-run # tarball must contain only plugin/, README, LICENSE, SECURITY, package.json
pnpm format        # prettier --write .
```

Before every commit run lint, typecheck, test, build, and `npm pack --dry-run`; all must pass.

## Layout

- `src/plugin.ts` plugin factory (`createPlugin(app, deps)`), router endpoints `/status`, `/pair`, `/unpair`
- `src/index.ts` default export loaded by signalk-server
- `src/pairing.ts` device-code pairing (start, poll with interval/slow_down handling)
- `src/http.ts` HTTP client (headers, timeout, `backoffDelay`, `retryAfterMs`, `HttpError`)
- `src/credential-store.ts` 0600 credential file, atomic write
- `src/queue.ts` crash-safe NDJSON store-and-forward queue (caps, torn-line repair)
- `src/redact.ts` secret redaction for anything that may be logged
- `src/config.ts` settings schema and defensive parsing (API URL rules)
- `src/contract.ts` wire constants and types mirrored from the platform contract
- `src/mapping.ts` permitted-path list, intentionally empty until upload ships; `src/ids.ts` UUIDv7
- `test/*.test.ts` one file per module (vitest); `docs/` public docs; `docker-compose.dev.yml` local server

## Conventions

- Build output is **CommonJS** (`plugin/`), because signalk-server `require()`s plugins. Do not switch
  the build to ESM.
- **Zero runtime dependencies.** Use `node:` built-ins and global `fetch`. Anything else needs a
  written justification in the PR. It must install on a Raspberry Pi with no native build step.
- TypeScript strict (incl. `noUncheckedIndexedAccess`); keep `SignalKApp` a minimal
  structural interface rather than importing server types.
- Tests never touch the network: inject `fetch` (`deps.fetch`, `HttpClient` option). Use vitest fake
  timers and injected `sleep`/`now`/`rng` for time and jitter. Use temp dirs for files. Every behavior
  change ships with a test. Core logic (backoff, queue caps) deserves property-style cases.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

## Hard rules

**Privacy.** Never read or send position, tracks, MMSI, callsign, vessel or crew names, free text, or
any AIS data. The only data sent at pairing is the set documented in the README privacy section; keep
that section and the code in agreement, and change both in the same PR. `src/mapping.ts` stays a closed
list of permitted paths; never add anything location-like.

**Credentials.**

- The `vti_...` credential lives only in `credential.json` inside the plugin data dir
  (`app.getDataDirPath()`), mode `0600`, written atomically. Never in plugin settings (readable via the
  admin API), never in queue files, never in status text.
- Never log an Authorization header, a credential, a device code, or a user code. Every string that may
  be logged goes through `redact`/`redactError`; wrap errors in `HttpError` (it redacts) and never
  forward raw fetch errors.
- Show the user code only in the status line and the `/status` response while pairing is pending.
- Credentials are write-scoped. Treat any change to storage, logging or redaction as security-sensitive.

**Transport.** HTTPS only, except `http://localhost`, `127.0.0.1`, `[::1]` for development. Every
request sends `User-Agent` and `X-VesselTwin-Contract: <int>`. Data goes only to the configured API URL.

**Error handling** (details in `docs/platform-handoff.md`):

- 401 on an authenticated call: stop, keep nothing retrying, tell the user to re-pair. Never loop on it.
- 403 `integration_paused_plan` and 503 `integration_feature_unavailable`: keep the queue, probe
  slowly (about hourly, or `Retry-After`), do not drop data.
- 429 and 5xx and network errors: exponential backoff with full jitter (5 s up to 30 min) and honor
  `Retry-After` when present (never retry sooner).
- 426 `integration_contract_unsupported` / 400 `integration_contract_required`: the plugin's contract is
  outside the server window. Stop uploading, keep the queue, surface "update the plugin", and never
  guess a different contract number. `GET /v1/integrations/status` reports `minContract`,
  `latestContract` and `pluginUpdateRecommended`.
- Show users neutral copy; never display raw server codes, quotas or internals.

**Queue invariants.** Append-only NDJSON, plain files. Crash safety: a torn final line is skipped and
repaired; acks rewrite via temp file + rename; segments rotate. Caps: 7 days and 50,000 readings,
oldest dropped first and the drop count surfaced in status. Single writer. Each reading carries a
UUIDv7 `clientReadingId` and its original `recordedAt` so replays are idempotent.

**Not yet available.** The platform has no ingest endpoints yet. Do not build, guess or call any
`/v1/integrations/signalk/*` route, and do not invent request shapes. The ingest JSON Schema and a new
contract version will be published first; vendor that schema and add a contract test against it, then
implement upload. Until then the plugin pairs, stores the credential, and reports that upload is
unavailable.

## Public repo hygiene

This repository is public. Never commit secrets, tokens, real credentials or pairing codes (use obvious
fakes in tests, e.g. `vti_` plus filler), personal paths, hostnames of private systems, or internal
planning detail. Keep docs to what an outside contributor needs. Local-only agent notes belong in
`CLAUDE.local.md`, which is gitignored; never commit it. Releases use npm provenance via trusted
publishing (OIDC, no long-lived npm token). **Releasing is a human step.**

## Git workflow

- Work on a branch, open a PR, wait for CI (`check` on Node 22 and 24). Never push directly to `main`
  once branch protection is on. Squash-merge.
- Agent commits end with a trailer: `Co-Authored-By: <agent name> <noreply address>`.
- Never publish to npm, create tags, create GitHub releases, change repo settings, or push, unless the
  owner explicitly says so in that session. Pushing and every other public write needs explicit approval.

## Smoke testing

1. `pnpm build`, then `docker compose -f docker-compose.dev.yml up` (stock signalk-server with `plugin/`
   mounted read-only). Admin UI at http://localhost:3000; create the admin user, then enable the plugin
   under Server > Plugin Config.
2. Set the plugin's API URL to a local or staging VesselTwin API (`http://localhost:3001` is allowed).
   A server where the integration is not enabled for the account answers pairing with 503; the plugin
   should report "unavailable" rather than crash. Do not point tests at production.
3. Start pairing from the plugin page, enter the shown code on the VesselTwin connect page, approve,
   then confirm `credential.json` exists with mode `0600` and no secret appears in the server log.
   Unpair must remove the file.
