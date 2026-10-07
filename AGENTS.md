# AGENTS.md

Guidance for AI agents and contributors working in this repository (Claude Code, Codex, Kiro, others;
`CLAUDE.md` is a symlink to this file, so both names read the same content). It stays lean on purpose: always-needed invariants only.
Volatile detail lives in the code (`ls src test`), `README.md`, and `docs/api.md`.

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
pnpm lint          # eslint . && prettier --check . && node scripts/check-public.mjs
pnpm typecheck     # tsc --noEmit over src + test
pnpm test          # vitest run
pnpm build         # rm -rf plugin && tsc -> plugin/ (gitignored)
pnpm check:public  # public-repo guard alone (also part of lint)
node scripts/check-public.mjs --pack  # after build: asserts the npm tarball holds only plugin/, README, LICENSE, SECURITY, package.json
pnpm hooks:install # optional pre-commit hook (runs the guard on staged files)
pnpm format        # prettier --write .
```

Before every commit run lint, typecheck, test, build, and `node scripts/check-public.mjs --pack`; all must pass.

## Layout

- `src/plugin.ts` plugin factory (`createPlugin(app, deps)`), router endpoints `/status`, `/pair`, `/unpair`
- `src/index.ts` default export loaded by signalk-server
- `src/pairing.ts` device-code pairing (start, poll with interval/slow_down handling)
- `src/http.ts` HTTP client (headers, timeout, `backoffDelay`, `retryAfterMs`, `HttpError`)
- `src/status.ts` status probe (`checkStatus`) and `StatusMonitor` (hourly probe, backoff, 401 handling)
- `src/credential-store.ts` 0600 credential file, atomic write; secret-free reauth tombstone after a 401
- `src/queue.ts` crash-safe NDJSON store-and-forward queue (caps, torn-line repair)
- `src/redact.ts` secret redaction for anything that may be logged
- `src/config.ts` settings schema and defensive parsing (API URL rules)
- `src/contract.ts` wire constants and types mirrored from the platform contract
- `src/mapping.ts` permitted-path list, intentionally empty until upload ships; `src/ids.ts` UUIDv7
- `scripts/check-public.mjs` public-repo guard (forbidden files, secrets, personal paths, tarball contents)
- `test/*.test.ts` one file per module (vitest); `docs/api.md` wire contract
- `dev/` mock API, docker rig and scripts for local testing (see `docs/TESTING.md`)

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
- Show the user code only in the admin-only `/status` response while pairing is pending. The status
  line is broadcast to read-only and anonymous clients and never carries the code or the URL.
- The credential is bound to `apiOrigin`: it is only ever sent to that origin. Never send it elsewhere.
- Keep the same-origin (`Origin`) check (`guarded`) on every plugin route.
- Credentials are write-scoped. Treat any change to storage, logging or redaction as security-sensitive.

**Transport.** HTTPS only, except `http://localhost`, `127.0.0.1`, `[::1]` for development. Every
request sends `User-Agent` and `X-VesselTwin-Contract: <int>`. Data goes only to the configured API URL.

**Error handling** (details in `docs/api.md`):

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

**Upload not built yet.** The platform's ingest API is defined under a newer contract version than the
plugin's current `CONTRACT_VERSION`. Do not build, guess or call any `/v1/integrations/signalk/*` route,
and do not invent request shapes, bump `CONTRACT_VERSION`, or add a path to `src/mapping.ts`, until (1) the
ingest JSON Schema for that contract version has been vendored into this repo with a contract test that
validates fixtures against it, and (2) the owner explicitly says to start upload work in that session.
Until then the plugin pairs, stores the credential, monitors status, and reports that upload is
unavailable.

## Public repo hygiene

This repository is public. Never commit secrets, tokens, real credentials or pairing codes (use obvious
fakes in tests, e.g. `vti_` plus filler), personal paths, hostnames of private systems, or internal
planning detail. Keep docs to what an outside contributor needs. Local-only agent notes belong in the
gitignored `CLAUDE.local.md` (Codex users: `AGENTS.override.md`); never commit them. Extra deny
patterns (one regex per line) go in the gitignored `.public-guard.local` or a file named by
`PUBLIC_GUARD_EXTRA_FILE`. `scripts/check-public.mjs` enforces all of this and runs inside `pnpm lint`
(and so in CI); do not weaken it. Releases use npm provenance via trusted publishing (OIDC, no
long-lived npm token). **Releasing is a human step.**

## Git workflow

- Work on a branch, open a PR, wait for CI (`check` on Node 22 and 24). Never push directly to `main`
  once branch protection is on. Squash-merge.
- Agent commits end with a trailer: `Co-Authored-By: <agent name> <noreply address>`.
- Never publish to npm, create tags, create GitHub releases, change repo settings, or push, unless the
  owner explicitly says so in that session. Pushing and every other public write needs explicit approval.

## Smoke testing

See the Development section in `CONTRIBUTING.md`. Never point tests at production.
