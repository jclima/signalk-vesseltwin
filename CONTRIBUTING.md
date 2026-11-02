# Contributing

- Node 20.19+ for development (tests run on vite 7; the plugin itself runs on Node 20.3+), pnpm 10. `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Conventional commits (`feat:`, `fix:`, `chore:`).
- Hard rules: never send or read position, MMSI or callsign; never log credentials or pairing codes;
  tests must not touch the network (inject `fetch`).
- Add tests with every behavior change. Keep runtime dependencies at zero unless justified.
- The wire contract is described in [docs/api.md](docs/api.md).
- Maintainers: the release procedure is in [docs/RELEASING.md](docs/RELEASING.md). `pnpm preflight` runs every check CI runs.

## Public-repo guard

This repository is public. `pnpm lint` also runs `scripts/check-public.mjs`, which fails on
secrets, personal paths, editor or agent config files, and local-only files that are tracked. After
`pnpm build`, `node scripts/check-public.mjs --pack` checks that the npm tarball contains only
`plugin/`, the six pairing page files (`public/index.html`, `icon.png`, `style.css`, `app.js`,
`view.js`, `controller.js`), `README.md`, `LICENSE`, `SECURITY.md` and `package.json`. CI runs both.

Optional pre-commit hook that runs the guard on staged files: `pnpm hooks:install`.

Maintainers can add private deny patterns (one regex per line, `#` comments) to the gitignored
`.public-guard.local`, or point `PUBLIC_GUARD_EXTRA_FILE` at a file of patterns.

## Releasing

Releasing is a maintainer step; contributors do not tag or publish. The procedure is in
[docs/RELEASING.md](docs/RELEASING.md).

## Development

```sh
git clone https://github.com/jclima/signalk-vesseltwin && cd signalk-vesseltwin
pnpm install
pnpm build        # compiles src/ to plugin/ (CommonJS; signalk-server require()s plugins) and
                  # web/ to public/*.js (the pairing page, plain ES modules; gitignored output)
pnpm test && pnpm lint && pnpm typecheck
```

### Smoke testing in a Signal K server

The `dev/` rig runs a stock `signalk-server` with the built plugin and a mock VesselTwin API. Start
with the walkthrough in [docs/TESTING.md](docs/TESTING.md); [dev/README.md](dev/README.md) is the
command reference. Never point tests at production.

The pairing page (`public/index.html`, `style.css`, `web/*.ts`) is a static Signal K webapp: no
dependencies, no bundler, no inline script or style (the page's CSP forbids them), and text goes in
through `textContent` only. Logic lives in `web/view.ts` and `web/controller.ts` (DOM-free, unit
tested); `web/app.ts` is the DOM glue. After `pnpm build`, open
<http://localhost:3100/signalk-vesseltwin/> in the rig (Webapps > VesselTwin) while signed in as admin.
