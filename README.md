# signalk-vesseltwin

[VesselTwin](https://vesseltwin.io) keeps your boat's maintenance record in one place. This
[SignalK](https://signalk.org) server plugin connects your boat's SignalK server to your VesselTwin
account so engine hours, battery readings and tank levels can feed that record once uploading is available.

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

The plugin adds a **VesselTwin** page to the SignalK admin UI. **Pair as an admin, with SignalK
security enabled** (see below).

1. Enable the plugin under Server > Plugin Config in the SignalK admin UI.
2. Open **Webapps > VesselTwin** (the VesselTwin tile appears once the plugin is enabled). Sign in to
   SignalK as an administrator if the page asks you to.
3. Choose **Pair**. The page shows a short code such as `ABCD-EFGH` and a link to VesselTwin. The code
   is shown only on this admin-only page and not in the plugin's status line on purpose: SignalK
   shows the status line to every client, including read-only and anonymous ones.
4. Open the link, sign in to VesselTwin, enter the code, choose your boat, and approve.
5. The plugin picks up the approval within a few seconds and then checks the connection. The page
   and the status line show `Paired with ...` once that works.

Without a browser (headless servers), the same steps work over HTTP as an admin: `POST
/plugins/signalk-vesseltwin/pair` starts pairing and `GET /plugins/signalk-vesseltwin/status` returns
`pairing.userCode` and `pairing.verificationUrl`. From a checkout of this repository,
`node dev/pair.mjs --no-approve` does this for you.

Choose **Cancel** on the page to abandon a pending pairing. If you approve in VesselTwin just as you
press Cancel, the approval may still go through on the VesselTwin side. If VesselTwin then lists the
connection but this page does not show the boat as paired, remove that connection in VesselTwin.

The code expires after 10 minutes. If it does, start pairing again.

The plugin's endpoints (`status`, `pair`, `unpair`) rely on the SignalK server's own access control
(see Security below). The page's own files (HTML, CSS, scripts) are public static files and contain
no secrets; every request to the plugin needs the admin login.

Other things the status line can tell you: the connection is paused, VesselTwin cannot be reached
right now (the plugin keeps trying), the plugin version is not supported (update the plugin), or the
pairing is no longer valid or the API address changed since pairing (pair again, or restore the
previous address; pairing again replaces the stored connection). When VesselTwin rejects
the stored connection, the plugin removes the secret from its data folder and keeps only a marker, so
it does not try the old credential again after a restart. An unexpected rejection that does not come
from VesselTwin itself (for example from a proxy) also stops the checks, but leaves the stored
connection in place.

**Unpair** (on the page, with a confirmation step, or `POST /plugins/signalk-vesseltwin/unpair`) only removes the stored connection on this
server. Also revoke the connection in VesselTwin so it stops working there; the plugin cannot do that
for you.

## Security

Pair from the SignalK admin UI with **SignalK security enabled**. With security enabled the plugin's
endpoints are admin-only by default (verified on signalk-server 2.33), and the plugin never lowers that. With security off, anyone who can reach your
server can read the pairing code and start pairing, and the plugin's browser same-origin check does
not protect against non-browser clients. The plugin does not block pairing in that case, so enable
SignalK security before you pair.

## What it sends (privacy)

- **Never sent: position, tracks, MMSI, callsign, vessel or crew names, or any AIS data.** The plugin
  does not read those paths.
- **Pairing** sends only: the provider (`"signalk"`), the plugin name and version, the contract
  version, the fixed device label "SignalK server", the requested scope, and optionally your SignalK server's own random install
  UUID, which is the vessel's SignalK self id (`urn:mrn:signalk:uuid:...`). A random UUID like this
  does not identify you or the boat by itself. It is sent only if the self id is a UUID (bare or
  with that prefix); an MMSI-based id or anything else is left out. Nothing else is sent before you
  approve.
- **Status check**: after pairing, on start and about once an hour, the plugin makes an authenticated
  request that asks VesselTwin whether the connection is still valid and which plugin versions it
  supports. It carries the credential and the contract version and **no boat data**.
- The credential is stored in the plugin's data directory with mode `0600`, never in plugin
  settings, and is never written to logs. It is bound to the API URL it was issued for and is sent
  only there. Redirects are never followed.
- Data is only sent to the API URL in the plugin settings (default `https://api.vesseltwin.io`). If
  that URL is invalid, the plugin reports a configuration error and makes no network calls.
- Uploading is not available yet. When it ships, only these values will be sent: engine and generator
  run time, battery voltage and state of charge, tank level and volume. The category toggles in the
  plugin settings take effect once upload is available. This section will be updated in the same
  release.

## Troubleshooting

- **"Unavailable" while pairing, or a paused connection.** The integration is off right now, or the
  account is not on the Pro plan. The plugin keeps working and checks again later; try pairing again
  later.
- **Disconnect or revoke.** Unpair removes the stored connection on this server; also revoke it in
  VesselTwin.
- **Asked to pair again.** VesselTwin no longer accepts the stored connection (revoked, expired, or it
  was issued for a different API URL). Start pairing again; the new connection replaces the old one.

## Contributing

Build instructions and the development workflow are in [CONTRIBUTING.md](CONTRIBUTING.md). The
wire contract is described in [docs/api.md](docs/api.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
