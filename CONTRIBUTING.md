# Contributing

- Node 22+, pnpm 10. `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Conventional commits (`feat:`, `fix:`, `chore:`).
- Hard rules: never send or read position, MMSI or callsign; never log credentials or pairing codes;
  tests must not touch the network (inject `fetch`).
- Add tests with every behavior change. Keep runtime dependencies at zero unless justified.
- The wire contract is described in [docs/api.md](docs/api.md).

## Public-repo guard

This repository is public. `pnpm lint` also runs `scripts/check-public.mjs`, which fails on
secrets, personal paths, editor or agent config files, and local-only files that are tracked. After
`pnpm build`, `node scripts/check-public.mjs --pack` checks that the npm tarball contains only
`plugin/`, the five pairing page files (`public/index.html`, `style.css`, `app.js`, `view.js`,
`controller.js`), `README.md`, `LICENSE`, `SECURITY.md` and `package.json`. CI runs both.

Optional pre-commit hook that runs the guard on staged files: `pnpm hooks:install`.

Maintainers can add private deny patterns (one regex per line, `#` comments) to the gitignored
`.public-guard.local`, or point `PUBLIC_GUARD_EXTRA_FILE` at a file of patterns.

## Releasing

Releasing is a maintainer step; contributors do not tag or publish.

1. Bump `version` in `package.json` (it must equal `PLUGIN_VERSION`; the tests check this).
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new version heading and date.
3. Open a PR to `main` and wait for CI (`check` on Node 22 and 24); squash-merge.
4. After the merge, the maintainer tags the merge commit on `main` as `vX.Y.Z` (matching
   `package.json`). The release workflow refuses tags that are not on `main` or do not match the
   version.
5. The environment reviewer approves the publish job; npm publishes with provenance.

Protect `v*.*.*` tags with a repository ruleset so only maintainers can create or move them.

The first release is planned as `v0.1.0`, after the open maintainer decisions are settled.

## Development

```sh
git clone https://github.com/jclima/signalk-vesseltwin && cd signalk-vesseltwin
pnpm install
pnpm build        # compiles src/ to plugin/ (CommonJS; signalk-server require()s plugins) and
                  # web/ to public/*.js (the pairing page, plain ES modules; gitignored output)
pnpm test && pnpm lint && pnpm typecheck
```

### Smoke testing in a SignalK server

The `dev/` directory holds a local rig: a stock signalk-server with the built plugin mounted, a mock
VesselTwin API (with fault injection) and helper scripts. See [dev/README.md](dev/README.md) for the
commands and [docs/TESTING.md](docs/TESTING.md) for the full walkthrough (mock API, a local VesselTwin
API, and a verification checklist).

```sh
pnpm build
docker compose -f dev/docker-compose.yml up -d --build
node dev/setup-signalk.mjs   # throwaway dev admin, enables the plugin
node dev/pair.mjs            # pairs against the mock
docker compose -f dev/docker-compose.yml down -v
```

The pairing page (`public/index.html`, `style.css`, `web/*.ts`) is a static SignalK webapp: no
dependencies, no bundler, no inline script or style (the page's CSP forbids them), and text goes in
through `textContent` only. Logic lives in `web/view.ts` and `web/controller.ts` (DOM-free, unit
tested); `web/app.ts` is the DOM glue. After `pnpm build`, open
<http://localhost:3100/signalk-vesseltwin/> in the rig (Webapps > VesselTwin) while signed in as admin.

Notes:

- A fresh server has security on, so the admin API (`/skServer/*`) and the plugin's endpoints
  (`/plugins/signalk-vesseltwin/*`) return 401 until an admin user exists and you send its bearer
  token. `dev/setup-signalk.mjs` does that for the rig.
- The plugin only accepts `http` for `localhost`, `127.0.0.1` and `[::1]`; other non-HTTPS URLs are
  rejected as a configuration error. Inside a Docker container `localhost` is the container itself,
  so `http://localhost:3001` only works through the rig's `relay` container, which forwards that port
  to the mock (or, with `RELAY_TARGET`, to an API on your host). Do not point tests at production.
- A server where the integration is off answers pairing with 503; the plugin reports "not available
  right now" instead of crashing.
- `dev/` is for testing only and is not published to npm. Tests (`pnpm test`) never use the network.
