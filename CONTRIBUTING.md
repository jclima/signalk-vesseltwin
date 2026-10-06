# Contributing

- Node 22+, pnpm 10. `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Conventional commits (`feat:`, `fix:`, `chore:`).
- Hard rules: never send or read position, MMSI or callsign; never log credentials or pairing codes;
  tests must not touch the network (inject `fetch`).
- Add tests with every behavior change. Keep runtime dependencies at zero unless justified.
