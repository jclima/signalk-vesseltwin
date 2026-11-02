## Release vX.Y.Z

- [ ] Version bumped in `package.json`, `PLUGIN_VERSION` (`src/plugin.ts`) and the README Status blockquote
- [ ] `CHANGELOG.md` has a dated `## [X.Y.Z] - YYYY-MM-DD` section and an empty `## [Unreleased]`
- [ ] `pnpm check:release --release X.Y.Z` exits 0 (paste its last line below; the first release also shows a "no earlier release" warning)
- [ ] README privacy section is unchanged, or updated in this PR together with the code that changed it
- [ ] Upload stays off by default; README keeps "Sending readings is off until you turn it on"
- [ ] CI is green on Node 20, 22 and 24

```
release-check: ...
```

Tagging and publishing are separate maintainer steps; see `docs/RELEASING.md`.
