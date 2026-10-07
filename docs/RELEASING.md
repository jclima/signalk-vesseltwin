# Releasing

How maintainers publish `signalk-vesseltwin` to npm. Releases use npm trusted publishing (GitHub
Actions OIDC) with provenance, so no long-lived npm token is stored anywhere. Publishing is a human
step: nothing here runs without a maintainer pushing a tag.

## Prerequisites

- Maintainer access to this repository and to the npm package (or the right to create it).
- Node 22+ and pnpm 10 locally, and an npm account with 2FA that can publish the package.
- The `npm-publish` GitHub environment exists (the workflow in `.github/workflows/release.yml` uses
  it). Add required reviewers there if you want an approval before each publish.
- Release workflow gate: `release.yml` only runs its publish job when the repository variable
  `NPM_TRUSTED_PUBLISHING` is `true`. Leave it unset until the trusted publisher is configured.

## Pre-release checklist

- [ ] `README.md` "Status" and "Install" wording matches what this release actually does and where
      it is published.
- [ ] `CHANGELOG.md`: move `Unreleased` entries under the new version heading with the date.
- [ ] `package.json` `version` is bumped to the new version.
- [ ] Privacy section in the README and the code agree (see `AGENTS.md`).
- [ ] CI is green on `main`.

## First publish

The npm trusted-publishing documentation (<https://docs.npmjs.com/trusted-publishers>) does not
state whether a trusted publisher can be configured for a package that does not exist yet. It does
say that a new configuration "must complete its first successful publish within 2 days". Do not
rely on pre-configuration. Publish the first version manually:

1. Land the release PR (version and changelog) on `main`, then from a clean checkout of `main`:

   ```sh
   pnpm install --frozen-lockfile
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm check:pack
   npm publish --access public
   ```

   This first version has no provenance attestation; that is expected.

2. On npmjs.com, open the package settings > Trusted Publisher and add GitHub Actions with owner
   `jclima`, repository `signalk-vesseltwin`, workflow filename `release.yml` and environment
   `npm-publish`.
3. Set the repository variable `NPM_TRUSTED_PUBLISHING` to `true`.
4. Do not tag the first version (it is already on npm). Start tagging from the next release.

## Routine releases

1. In a PR, bump `version` in `package.json` and update `CHANGELOG.md`. Merge it.
2. Tag the merge commit on `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `Release` workflow checks that the tag equals the `package.json` version, runs lint,
   typecheck, tests, build and the tarball check, then runs `npm publish --provenance`.
4. If the `npm-publish` environment has reviewers, approve the run.

## After publishing

- `npm view signalk-vesseltwin version dist.attestations` shows the new version (and provenance for
  workflow publishes).
- The SignalK Appstore lists packages carrying the `signalk-node-server-plugin` keyword. The
  listing can lag behind npm by a while; check the Appstore in a SignalK server after some time.
- Install it in a test SignalK server and confirm the plugin loads and its status line is correct.

## Rolling back

- Prefer `npm deprecate signalk-vesseltwin@X.Y.Z "reason, use X.Y.Z+1"` and publish a fixed
  version.
- `npm unpublish` is restricted: it is generally only possible within 72 hours of publishing, or
  when no other package depends on it, and a version number can never be reused. See the npm
  unpublish policy before relying on it.
