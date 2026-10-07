# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Pre-release; not yet published to npm.

### Added

- Device-code pairing with a VesselTwin account: the plugin starts pairing, an admin reads the code
  from the plugin's `status` endpoint, and the owner approves it in VesselTwin.
- Credential storage in the plugin's data directory (mode `0600`, written atomically), bound to the
  API URL it was issued for, with a secret-free marker after VesselTwin rejects it.
- Hourly connection status check with backoff, and a status line that reports pairing, pause,
  unreachable and "update the plugin" states.

### Not yet available

- Uploading engine hours, battery readings and tank levels. The plugin reports this in its status
  line.
