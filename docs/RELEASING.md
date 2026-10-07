# Releasing

How maintainers publish `signalk-vesseltwin` to npm. Releases use npm trusted publishing (GitHub
Actions OIDC) with provenance, so no long-lived npm token is stored anywhere. Publishing is a human
step: nothing here runs without a maintainer pushing a tag.

`scripts/release-check.mjs` (run as `pnpm check:release <mode>`) enforces the rules below. Exit codes:
0 ok, 1 findings, 2 usage, 3 environment problem (git, files, `origin/main` or the npm registry
unavailable). Exit 3 is never a pass. `pnpm lint` runs its `--ci` mode on every PR.

## 0. One-time setup

- Maintainer access to this repository and to the npm package (or the right to create it), Node 22+
  and pnpm 10 locally, and an npm account with 2FA that can publish the package.
- The `npm-publish` GitHub environment exists (`.github/workflows/release.yml` uses it). Add required
  reviewers there if you want an approval before each publish.
- `release.yml` only runs its publish job when the repository variable `NPM_TRUSTED_PUBLISHING` is
  `true`. Leave it unset until the trusted publisher is configured.
- A repository ruleset protects `v*.*.*` tags, so only maintainers can create or move them.
- Branch protection on `main` requires the `check (22)` and `check (24)` CI checks.
- The package version is already `0.1.0` on `main` (not yet published). The first release is `0.1.0`
  and needs no further version bump.

The npm trusted-publishing documentation (<https://docs.npmjs.com/trusted-publishers>) does not state
whether a trusted publisher can be configured for a package that does not exist yet, and a new
configuration must complete its first successful publish within 2 days. Publish the first version
manually:

1. Prepare and merge the release PR (stages 1 to 3 below), then from a clean checkout of the merged
   `origin/main`:

   ```sh
   pnpm install --frozen-lockfile
   pnpm preflight
   pnpm check:release --release X.Y.Z --pre-tag --online
   npm publish --access public
   ```

   Use npm >= 11.5.1 for trusted publishing (the workflow checks this; the first manual publish does
   not use OIDC). `pnpm check:pack` asserts the tarball holds only `plugin/`, the five pairing page files in
   `public/` (`index.html`, `style.css`, `app.js`, `view.js`, `controller.js`), `README.md`,
   `LICENSE`, `SECURITY.md` and `package.json`. `npm publish` runs `prepack`, which rebuilds. This
   first version has no provenance attestation; that is expected.

2. On npmjs.com, open the package settings > Trusted Publisher and add GitHub Actions with owner
   `jclima`, repository `signalk-vesseltwin`, workflow filename `release.yml` and environment
   `npm-publish`.
3. Tag the commit you just published and push the tag (stage 4 commands). The workflow does nothing
   yet because the variable is still unset. The tag gives later releases a baseline version.
4. Set the repository variable `NPM_TRUSTED_PUBLISHING` to `true`.

## 1. Plan

```sh
pnpm check:release --plan --online
```

Prints the baseline (highest earlier release from tags, dated changelog sections and the npm latest),
the allowed next versions, and how many entries sit under each `Unreleased` heading.

Versioning while the version is below 1.0.0: a patch bump for fixes, a minor bump for features or
anything users must notice, and `1.0.0` only as a deliberate decision. Prerelease versions are
rejected by the checks for now.

## 2. Freeze and readiness

On a branch `release/vX.Y.Z`:

- Bump `version` in `package.json` and `PLUGIN_VERSION` in `src/plugin.ts`. They must be equal
  (`test/` and `release-check` both enforce it). For the first release no bump is needed: `main` is
  already at `0.1.0` (unpublished), so the release PR mainly dates the CHANGELOG section and fixes
  the README Status and Install copy, if that is not already done.
- Update the README Status line and Install text to match what this release does and where it is
  published. Keep the privacy section and the code in agreement (see `AGENTS.md`).
- In `CHANGELOG.md`, move the `Unreleased` entries under `## [X.Y.Z] - YYYY-MM-DD` and leave an empty
  `## [Unreleased]` above it.
- Commit the changes, then run `pnpm preflight && pnpm check:release --release X.Y.Z` (the check
  needs a clean tree, so it reports `git/clean` until you commit).

## 3. Release PR

```sh
gh pr create --template release.md
```

Wait for CI (`check (22)` and `check (24)`, required by branch protection), then squash-merge.

## 4. Tag (maintainer only)

Do not run `git switch main` from a worktree. From a clean checkout, tag the merged commit:

```sh
git fetch origin
pnpm check:release --release X.Y.Z --pre-tag --online
git tag -a vX.Y.Z origin/main -m "vX.Y.Z"
git push origin vX.Y.Z
```

## 5. Publish

Pushing the tag starts the `Release` workflow (only when `NPM_TRUSTED_PUBLISHING` is `true`; tags
matching `v*.*.*` are protected by a ruleset). On Node 24 it requires npm >= 11.5.1, fetches
`origin/main`, runs `release-check --tag --online` (tag equals `v` plus the `package.json` version, and
the tagged commit must be on `main`), then `pnpm preflight` (lint, typecheck including `tsc -p web`,
tests, build, tarball check), then `npm publish --provenance --access public --ignore-scripts`.
`--ignore-scripts` skips `prepack`, so the tarball is exactly the build that was just checked. The
tarball holds only `plugin/`, the five `public/` files, README, LICENSE, SECURITY and `package.json`.
Approve the `npm-publish` environment if it has reviewers. If a run fails for infrastructure reasons, re-run it. Never move or
delete a pushed tag; if the tag is wrong, fix forward with a new version.

## 6. Verify

```sh
pnpm check:release --verify-published X.Y.Z
```

- The SignalK Appstore lists packages carrying the `signalk-node-server-plugin` keyword. The listing
  can lag behind npm by a while; check the Appstore in a SignalK server after some time.
- Install the published version in a test SignalK server and confirm the plugin loads and its status
  line is correct (see `docs/TESTING.md`).
- Optional GitHub release notes: `pnpm check:release --print-notes X.Y.Z` prints the changelog
  section, for example `gh release create vX.Y.Z --notes "$(pnpm -s check:release --print-notes X.Y.Z)"`.

## 7. Roll back

- Prefer `npm deprecate signalk-vesseltwin@X.Y.Z "reason, use X.Y.Z+1"` and publish a fixed version.
- `npm unpublish` is restricted: it is generally only possible within 72 hours of publishing, or
  when no other package depends on it, and a version number can never be reused. See the npm
  unpublish policy before relying on it.
- Fix forward with a new version. Never reuse a version number.

## What the checks guard

| Check id                                               | Guards                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `version-sync/plugin`                                  | `PLUGIN_VERSION` equals the `package.json` version                         |
| `version-sync/readme`                                  | versions in the README Status line equal the `package.json` version        |
| `changelog/bump-has-section`                           | a bumped version has a dated changelog section                             |
| `contract/doc`                                         | `docs/api.md` states the same contract as `CONTRACT_VERSION`               |
| `upload/mapping-empty`, `upload/no-ingest-route`       | upload stays unbuilt until it is approved (see `AGENTS.md`)                |
| `upload/status-copy`, `upload/readme`                  | the status line and README keep saying that upload is unavailable          |
| `release/version-arg`                                  | the release version is strict `X.Y.Z`, not a prerelease, and matches       |
| `release/bump`                                         | the version is the next patch, minor or major after the baseline           |
| `changelog/section`                                    | topmost, dated (not in the future), non-empty section, releases descending |
| `changelog/unreleased`                                 | `Unreleased` is empty at release time                                      |
| `readme/released-copy`                                 | no "not yet published" wording left in the README or release notes         |
| `git/clean`                                            | no uncommitted changes                                                     |
| `git/at-origin-main`, `git/tag-absent`                 | tagging from the merged commit, and the tag does not exist yet             |
| `tag/match`, `tag/on-main`                             | the tag equals `v` plus the version and is reachable from `origin/main`    |
| `registry/not-published`, `registry/bump` (`--online`) | the version is not on npm yet and is above the npm latest                  |
| `verify/present`, `verify/latest`, `verify/provenance` | after publishing: version on npm, tagged `latest`, provenance (warning)    |
