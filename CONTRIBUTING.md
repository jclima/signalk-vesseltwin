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

Either link into a local server (`cd ~/.signalk && npm install /path/to/signalk-vesseltwin`, restart,
enable the plugin in Server > Plugin Config), or use the dev container:

1. `pnpm build`, then `docker compose -f docker-compose.dev.yml up` (stock signalk-server with
   `plugin/` mounted read-only). Admin UI at http://localhost:3000; create the admin user, then enable
   the plugin under Server > Plugin Config. A fresh server has security on, so the admin API
   (`/skServer/*`) and the plugin's endpoints (`/plugins/signalk-vesseltwin/*`) return 401 until an
   admin user exists; for curl or scripted testing, create the admin first and send its bearer token.
2. Set the plugin's API URL to a local or test VesselTwin API. `http://localhost:3001` is allowed;
   other non-HTTPS URLs are rejected. A server where the integration is not enabled for the account
   answers pairing with 503; the plugin should report "unavailable" rather than crash. Do not point
   tests at production.
3. Start pairing from the plugin page, enter the shown code on the VesselTwin connect page, approve,
   then confirm `credential.json` exists in the plugin data directory with mode `0600` and no secret
   appears in the server log. Unpair must remove the file.
