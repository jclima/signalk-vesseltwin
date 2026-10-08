# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once released.

## [Unreleased]

## [0.1.1] - 2026-10-07

### Fixed

- The status line no longer says a plugin update is available when none has been released; plugin
  updates appear in the SignalK Appstore.

## [0.1.0] - 2026-10-07

Uploading engine, battery and tank readings is not built: the plugin pairs, stores its
credential, monitors status, and says that data upload is not available in this version.

### Added

- A pairing page in the SignalK admin Webapps list (Webapps > VesselTwin): shows the pairing code with
  a countdown, the connection state, and Pair, Cancel and Unpair buttons (Unpair asks to confirm).
- Cancel pairing from the page or the `/pair/cancel` endpoint.
- Device-code pairing with a VesselTwin account: the plugin starts pairing, an admin reads the code
  from the plugin's `status` endpoint (or the pairing page), and the owner approves it in VesselTwin.
- Credential storage in a private file (mode `0600`, written atomically) in the plugin data
  directory, bound to the API URL it was issued for, with a secret-free marker after VesselTwin
  rejects it.
- Hourly connection status check with backoff, a status line that reports pairing, pause,
  unreachable and "update the plugin" states, and a clear re-pair prompt when the connection is
  rejected.
- A crash-safe local queue module, secret redaction for anything logged, and a local test rig with a
  mock VesselTwin API (`dev/`).
- A public-repo guard that fails CI on secrets, personal paths, local-only files and unexpected files
  in the npm tarball.
- Release readiness: an opt-in publish workflow (runs only when the repository variable
  `NPM_TRUSTED_PUBLISHING` is `true`) that checks the tag matches the package version, and a
  maintainer release procedure in `docs/RELEASING.md`.

### Changed

- Pairing now survives network errors while waiting for approval instead of giving up.
- A pairing that is approved but cannot be saved locally now gets its own message instead of 'VesselTwin is not available'.
- An unusable answer from VesselTwin at the end of pairing now gets its own message (remove the connection in VesselTwin, check for a plugin update, pair again) instead of a data-folder permissions hint.
- The vessel-details suggestion setting no longer covers the vessel name.
- Settings that have no effect in this version are labelled as inactive.
- The release workflow is hardened: pinned action versions, no persisted checkout credentials, a
  check that the tagged commit is on `main`, an npm version check, no package-manager cache, and
  publishing with `--ignore-scripts`.

### Security

- Plugin routes are admin-only and check the request origin.
- The pairing code never appears in the status line shown to read-only clients.

### Not yet available

- Uploading engine hours, battery readings and tank levels. The plugin reports this in its status
  line.
