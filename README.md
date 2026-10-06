# signalk-vesseltwin

A [SignalK](https://signalk.org) server plugin that pairs your boat's SignalK server with
[VesselTwin](https://vesseltwin.io) so engine hours, battery readings and tank levels can feed your
maintenance record.

> **Status: pre-release (0.0.0).** Pairing and credential handling are implemented. **Uploading
> readings is not implemented yet**; it waits for the VesselTwin ingest API. The plugin is not
> published to npm or the SignalK appstore, and the VesselTwin integration is not yet generally
> available.

## Privacy

- **Never sent in v1: position, tracks, MMSI, callsign, or any AIS data.** The plugin does not read
  those paths, and the server rejects them.
- Pairing sends only: the plugin name and version, the contract version, the fixed device label
  "SignalK server", the requested scope, and your SignalK server's own random install UUID (a
  server identifier, not a vessel identity). Nothing else is sent before you approve.
- Once upload ships, only these allowlisted values will be sent: engine and generator run time,
  battery voltage and state of charge, tank level and volume, plus (optional, off by default)
  vessel name and dimensions as suggestions you approve in VesselTwin.
- The credential is stored in the plugin's data directory with mode `0600`, never in plugin
  settings, and is never written to logs. You can revoke it from VesselTwin in one click or run
  unpair from the plugin page.
- Data is only sent to the API URL in the plugin settings (default `https://api.vesseltwin.io`).

## Install

Once published: SignalK admin UI > Appstore > search "VesselTwin" > Install > restart the server.

## Pairing walkthrough

_Placeholder until the web flow is public._ The plugin shows a code such as `ABCD-EFGH` in its
status line; you open the VesselTwin connect page, type the code, choose the vessel you own, and
approve. A Pro plan is required.

## Development

Requires Node 22+ and pnpm 10.

```sh
git clone https://github.com/jclima/signalk-vesseltwin && cd signalk-vesseltwin
pnpm install
pnpm build        # compiles src/ to plugin/ (CommonJS; signalk-server require()s plugins)
pnpm test && pnpm lint && pnpm typecheck
```

Try it in a SignalK server, either:

- link into a local server: `cd ~/.signalk && npm install /path/to/signalk-vesseltwin`, restart the
  server, enable the plugin in Server > Plugin Config; or
- `docker compose -f docker-compose.dev.yml up` (mounts `plugin/`), admin UI on
  http://localhost:3000.

Point the plugin's API URL at a local or staging VesselTwin API (`http://localhost:3001` is allowed;
other non-HTTPS URLs are rejected). Because the integration is not yet generally available,
production may answer pairing requests with 503.

## License

Apache-2.0. See [LICENSE](LICENSE).
