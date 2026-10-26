# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once released.

## [Unreleased]

### Fixed

- A failed unpair no longer leaves the status stuck on "checking": the stored connection is restored
  so unpairing can be retried.
- `/status` reports "checking" instead of "not paired" while the stored connection is still loading.
- A reading that arrives as the plugin stops is no longer treated as recorded, so it is kept after a
  restart.
- An upload pause no longer delays sending by up to another hour after the connection is back; only
  the server's `Retry-After` is waited out.
- The uploader no longer stalls when it is held and resumed while a send is finishing, and it retries
  within seconds, not a full interval, after a long run of invalid queued readings.
- Readings held for review are no longer counted as rejected.
- A source clock that steps back by more than six hours no longer silences a channel until real time
  catches up.
- A failure while starting the collector is logged and no longer an unhandled rejection.
- Acknowledging sent readings reads fewer queue files, and the list of refused channels is bounded.

## [0.2.1] - 2026-10-11

### Added

- VesselTwin icon for the SignalK Appstore listing and the plugin's pairing page.

### Changed

- README states that connecting requires a VesselTwin Pro plan.

## [0.2.0] - 2026-10-11

### Added

- Status line "Sending is on; waiting for readings from SignalK." until a first reading is recorded.
- Downgrade note: turn sending off before going back to 0.1.x so waiting readings are deleted.
- Upload of engine and generator hours, battery voltage and state of charge, and tank level and
  volume to the boat's maintenance record. **Off by default**: nothing is sent until the owner turns
  on "Send readings to VesselTwin" and a category in the plugin settings. Only the SignalK path
  (with the owner's instance id), the raw value, a UTC timestamp and a random reading id are sent;
  never position, MMSI, names or AIS.
- A "channels need setup" prompt: when VesselTwin is waiting for the owner to map or confirm
  channels, the status line says so (without numbers) and the VesselTwin page shows how many.
- A store-and-forward queue on disk (7 days, 50,000 readings, oldest dropped first) so readings
  survive outages and restarts, with idempotent replays. The VesselTwin page shows whether sending
  is on, how many readings are waiting and when the last batch went out.
- Upload settings per category (engine hours, batteries, tanks): on/off, how often to record
  (60 to 1440 minutes), minimum change, and which instances. Also a single send interval. Defaults
  send the least data (at most once a day).

### Fixed

- Saved channel state is never rewritten after the queue was cleared, is sanity-checked when loaded,
  and the queue is cleared when sending is on but no category is selected. A 401 during start no
  longer leaves a collector running.
- Saving the pairing credential works on filesystems that do not support changing file
  permissions (for example FAT-formatted USB drives). When the file cannot be restricted to the
  server's user there, the plugin page now warns about it (admin only; nothing in the status line).
- Two overlapping unpair requests no longer reopen pairing before the later one has finished.
- Restarting the plugin while an unpair is in progress no longer leaves the status monitor in an
  inconsistent state.
- Readings are kept in raw SignalK (SI) units for upload; conversion happens server-side.
- Upload settings form: tank ids such as `fuel.0` are no longer rejected by the form, labels and
  hints are clearer, and the admin status reports both the configured (`enabled`) and effective
  (`active`) state per category.
- The status line is no longer sent to the server again when it has not changed.

### Changed

- The plugin now speaks contract 2 (the VesselTwin server still accepts contract 1).
- `uploadEnabled` ("Send readings to VesselTwin") is the master switch. The older `sendEngineHours`,
  `sendBatteries` and `sendTanks` settings no longer enable anything: owners who had them on must turn
  sending on again, and the VesselTwin page says so.
- The status line now says whether readings are being sent, and no longer says that upload is not
  available. While paused or offline with sending on, it says readings are kept for up to 7 days.
- The `samplePeriodSeconds` setting is removed; a saved value is ignored.
- Tank ids are limited to the nine tank types the contract defines (`fuel`, `freshWater`,
  `wasteWater`, `blackWater`, `lubrication`, `liveWell`, `baitWell`, `gas`, `ballast`).
- `Retry-After` is honoured up to 24 hours (larger values are capped).
- Turning sending off, restarting with it off, or unpairing deletes any readings still waiting.
- The offline queue now applies its age and count caps when it starts.
- The old "suggest vessel dimensions" setting is hidden; it is ignored.
- Supports Node.js 20.3 and newer, so the plugin runs on Victron Cerbo GX (Venus OS).

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
