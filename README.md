# signalk-vesseltwin

[VesselTwin](https://vesseltwin.io) keeps your boat's maintenance record in one place. This
[SignalK](https://signalk.org) server plugin connects your boat's SignalK server to your VesselTwin
account so engine hours, battery readings and tank levels can feed that record.

> **Status: pre-release (0.0.0).** Connecting your boat works. **Sending readings is not available
> in this version yet**; the plugin says so in its status line. It is not yet published to npm or
> the SignalK appstore.

## Install

Once published: SignalK admin UI > Appstore > search "VesselTwin" > Install > restart the server.
Then enable it under Server > Plugin Config.

## Connect your boat

Connecting requires a VesselTwin account ([sign up at vesseltwin.io](https://vesseltwin.io)) on the
**Pro plan**. Accounts on other plans cannot pair, and the integration may not be available to every
account yet.

1. In the SignalK admin UI open the VesselTwin plugin and start pairing.
2. The plugin shows a short code such as `ABCD-EFGH` in its status line.
3. Open the connect page at [vesseltwin.io](https://vesseltwin.io) and sign in.
4. Enter the code, choose your boat, and approve.
5. The plugin picks up the approval within a few seconds and shows that it is connected.

The code expires after 10 minutes. If it does, start pairing again.

## What it sends (privacy)

- **Never sent: position, tracks, MMSI, callsign, or any AIS data.** The plugin does not read those
  paths.
- Pairing sends only: the plugin name and version, the contract version, the fixed device label
  "SignalK server", the requested scope, and your SignalK server's own random install UUID (a
  server identifier, not a vessel identity). Nothing else is sent before you approve.
- Once upload is available, only these values will be sent: engine and generator run time, battery
  voltage and state of charge, tank level and volume, plus (optional, off by default) vessel name and
  dimensions as suggestions you approve in VesselTwin.
- The credential is stored in the plugin's data directory with mode `0600`, never in plugin
  settings, and is never written to logs.
- Data is only sent to the API URL in the plugin settings (default `https://api.vesseltwin.io`).

## Troubleshooting

- **Pairing says the integration is unavailable.** It is not enabled for your account right now, or your account is not on the Pro plan.
  The plugin keeps working and you can try again later.
- **Disconnect or revoke.** Use unpair on the plugin page, which deletes the stored credential, and/or
  revoke the connection in VesselTwin.
- **Asked to pair again.** The connection was revoked or expired; start pairing again.

## Contributing

Build instructions and the development workflow are in [CONTRIBUTING.md](CONTRIBUTING.md). The
wire contract is described in [docs/api.md](docs/api.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
