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
`plugin/`, `README.md`, `LICENSE`, `SECURITY.md` and `package.json`. CI runs both.

Optional pre-commit hook that runs the guard on staged files: `pnpm hooks:install`.

Maintainers can add private deny patterns (one regex per line, `#` comments) to the gitignored
`.public-guard.local`, or point `PUBLIC_GUARD_EXTRA_FILE` at a file of patterns.

## Development

```sh
git clone https://github.com/jclima/signalk-vesseltwin && cd signalk-vesseltwin
pnpm install
pnpm build        # compiles src/ to plugin/ (CommonJS; signalk-server require()s plugins)
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
