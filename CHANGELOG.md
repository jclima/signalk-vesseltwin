# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once released.

## [Unreleased]

Pre-release (`0.0.0`); nothing is published to npm yet. Uploading engine, battery and tank readings
is not built: the plugin pairs, stores its credential, monitors status, and says that data upload is
not available in this version.

### Added

- A pairing page in the SignalK admin Webapps list (Webapps > VesselTwin): shows the pairing code with
  a countdown, the connection state, and Pair, Cancel and Unpair buttons (Unpair asks to confirm).
- Cancel pairing from the page or the `/pair/cancel` endpoint.
- Device-code pairing with the VesselTwin web app, credential stored in a private file in the plugin
  data directory, hourly status probe with backoff, and a clear re-pair prompt when the connection is
  rejected.
- A crash-safe local queue module, secret redaction for anything logged, and a local test rig with a
  mock VesselTwin API (`dev/`).
- A public-repo guard that fails CI on secrets, personal paths, local-only files and unexpected files
  in the npm tarball.

### Changed

- Pairing now survives network errors while waiting for approval instead of giving up.
- A pairing that is approved but cannot be saved locally now gets its own message instead of 'VesselTwin is not available'.
- An unusable answer from VesselTwin at the end of pairing now gets its own message (remove the connection in VesselTwin, check for a plugin update, pair again) instead of a data-folder permissions hint.
- The vessel-details suggestion setting no longer covers the vessel name.
- Settings that have no effect in this version are labelled as inactive.

### Security

- Plugin routes are admin-only and check the request origin.
- The pairing code never appears in the status line shown to read-only clients.
