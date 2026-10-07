## Release vX.Y.Z

- [ ] Version bumped in `package.json`, `PLUGIN_VERSION` (`src/plugin.ts`) and the README Status and Install text
- [ ] `CHANGELOG.md` has a dated `## [X.Y.Z] - YYYY-MM-DD` section and an empty `## [Unreleased]`
- [ ] `pnpm check:release --release X.Y.Z` prints `release-check: ok` (paste the last line below)
- [ ] README privacy section is unchanged, or updated in this PR together with the code that changed it
- [ ] The plugin still reports that data upload is unavailable (or this release is explicitly approved to change that)
- [ ] CI is green on Node 22 and 24

```
release-check: ...
```

Tagging and publishing are separate maintainer steps; see `docs/RELEASING.md`.
