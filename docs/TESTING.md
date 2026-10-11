# Testing the plugin in a real SignalK server

Unit tests (`pnpm test`) never touch the network. This page is for manual runs of the built plugin in
a stock signalk-server, against either a mock VesselTwin API (Track A) or a VesselTwin API you run
locally (Track B). The rig lives in `dev/` (see [dev/README.md](../dev/README.md)); it is for testing
only and is not published to npm. Never point tests at production.

Needs Docker and Node >= 20.19 to run the repository tooling and tests (the plugin itself runs on Node >= 20.3). Run everything from the repository root.

## How you drive the plugin

- The plugin adds a **VesselTwin** page to the SignalK admin UI (Webapps, served at
  `/signalk-vesseltwin/`). Open <http://localhost:3100/signalk-vesseltwin/> after signing in at
  `/admin/`. The page shows the pairing code and buttons. The same flow also works over HTTP:
  `POST /plugins/signalk-vesseltwin/pair` starts pairing (`node dev/pair.mjs` does this) and the code is
  in the admin-only `GET /plugins/signalk-vesseltwin/status` response under `pairing.userCode`. The
  status line (SignalK admin UI, Server > Plugin Config) only says "Pairing in progress" and points to
  the page, because it is broadcast to every client.
- These routes sit behind the server's admin login. `node dev/setup-signalk.mjs` creates a throwaway
  admin, saves a bearer token to `.signalk-dev/token` (gitignored, file mode 0600, directory 0700; the script never prints
  it) and enables the plugin.
- Handy shell helpers used below:

```sh
T=$(cat .signalk-dev/token)
st()   { curl -s -H "authorization: Bearer $T" localhost:3100/plugins/signalk-vesseltwin/status; echo; }
fault(){ curl -s -X POST localhost:3001/__mock/fault -H 'content-type: application/json' -d "$1"; echo; }
mlog() { curl -s localhost:3001/__mock/log; echo; }   # method, path, status, time; never codes or credentials
```

### Testing with SignalK security disabled

The stock `signalk/signalk-server` image starts the server through `startup.sh`, which always passes
`--securityenabled`, so security cannot be switched off in the admin UI or settings of that image. To
see the plugin behave on a server with security off (for example to check the README security note),
override the entrypoint in a compose override file. **For local testing only; never do this on a real
boat.**

```yaml
# dev/docker-compose.nosecurity.yml
services:
  signalk:
    entrypoint: ['/home/node/signalk/node_modules/signalk-server/bin/signalk-server']
```

```sh
docker compose -f dev/docker-compose.yml -f dev/docker-compose.nosecurity.yml up -d --build
```

Use a fresh volume (`down -v` first). `node dev/setup-signalk.mjs` does not apply here (there is no
login): enable the plugin and set `apiBaseUrl` to `http://localhost:3001` in the admin UI, then drive
it with `SK_NO_AUTH=1 node dev/pair.mjs` and plain `curl` without the `authorization` header. Delete the
override file afterwards.

### Triggering a status check on demand

The plugin checks status once when it starts, once after pairing, then about hourly. To probe right
after injecting a fault, restart the plugin by re-saving its configuration, which makes signalk-server
stop and start it:

```sh
node dev/setup-signalk.mjs      # idempotent: logs in, re-saves the plugin config, prints the plugin status
# or, without the script:
curl -s -X POST localhost:3100/skServer/plugins/signalk-vesseltwin/config \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"enabled":true,"configuration":{"apiBaseUrl":"http://localhost:3001"}}'
```

The stored credential is kept across such a restart, so the plugin makes one status request on start.
Wait a few seconds, then call `st` and `mlog`.

## Track A: mock API

```sh
pnpm build
docker compose -f dev/docker-compose.yml up -d --build
node dev/setup-signalk.mjs
node dev/pair.mjs
```

After a later `pnpm build`, restart the signalk container so it loads the new plugin code
(`docker compose -f dev/docker-compose.yml restart signalk`, then `node dev/setup-signalk.mjs`);
`up -d --build` alone keeps serving the old code.

`dev/pair.mjs` starts pairing, prints the pending status (with `pairing.userCode`), approves that code
on the mock, then waits for the first status check. Expected end:

```
final status: {"state":"connected","paired":true,"vesselLabel":"Mock Boat", ... "pairing":null, ...}
PAIRED (state: connected)
```

The status line (admin UI) reads `Paired with Mock Boat. Sending readings is off in the plugin
settings.` because sending is off by default (see "Track A: upload end to end" to turn it on). The
mock mirrors the real server's contract window (min 1, latest 2) and the plugin speaks contract 2, so
`updateRecommended` is `false` in the admin `/status` response. The mock log shows `POST pairing/start`, `POST pairing/token`, then `GET status` (200, with
auth).

### Fault injections

Inject with `fault`, restart the plugin (see above), then check `st` and `mlog`. Clear with
`fault '{"route":"clear"}'`. Full option list: [dev/README.md](../dev/README.md).

| Inject (`route: "status"`)                          | Expected `state`  | Status line (after `Paired with Mock Boat.`; sending off)                                                  |
| --------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `{"status":503}`                                    | `paused`          | `VesselTwin integrations are not available for your account right now. The plugin will keep checking. ...` |
| `{"status":403}`                                    | `paused`          | `The connection is paused for your VesselTwin plan. The plugin will keep checking. ...`                    |
| `{"status":200,"minContract":2}`                    | `update_required` | `This plugin version is not supported by VesselTwin. Update the plugin. ...`                               |
| `{"status":426,"minContract":2}`                    | `update_required` | same as above                                                                                              |
| `{"status":401}`                                    | `reauth_required` | `Pairing with VesselTwin is no longer valid. Pair again. ...` (no `Paired with` prefix)                    |
| `{"status":429,"retryAfter":30}` or `5xx`           | `offline`         | `Cannot reach VesselTwin right now. The plugin will keep trying. ...`                                      |
| `{"status":200,"minContract":1,"latestContract":1}` | `connected`       | same line as the default; `updateRecommended` is `false` (as with the default window 1..2)                 |

With sending on (see below) the `paused` and `offline` lines end with `Readings are kept for up to 7
days.` and the `connected` line reads `Sending readings to VesselTwin.`; with sending off the lines
carry neither. The `connected` line ends with `Sending readings is off in the plugin settings.` when it
is off.

Details worth checking:

- **503 with `Retry-After`**: the mock defaults `Retry-After` to 3600. The state is `paused`, and the
  mock log shows no further `GET status` until at least `Retry-After` (never sooner than an hour in
  any case). Wait a minute or so and confirm the log has not grown.
- **401**: `paired` is `false` and `credential.json` is replaced by a tombstone with the keys
  `reauthRequired`, `vesselLabel`, `apiOrigin`, `pairedAt` and **no** `credential` or `credentialId`
  (print key names only, see the checklist). Note how many `GET status` lines the mock log has, then
  restart the plugin: the state is `reauth_required` again and the log shows **no further status
  request**; there is no retry loop. Clear the fault and run `node dev/pair.mjs` again: pairing is
  allowed in `reauth_required`, overwrites the tombstone with a credential and ends in `connected`.
  `POST /unpair` on a tombstone deletes it.
- **401 with another code** (`{"route":"status","status":401,"code":"proxy_error"}`): the state is
  `reauth_required` and probing stops, but `credential.json` still holds the credential (no
  tombstone); a restart probes once more.
- **Origin binding**: change the plugin's `apiBaseUrl` to a different local origin (for example
  `http://127.0.0.1:3001`, which the relay does not serve) while a credential exists: the state is
  `reauth_required` and the mock log shows no request at all. The status line says `The VesselTwin
API address changed since pairing. Pair again, or restore the previous address. ...` (no URL, and
  not the generic 401 copy). Restore the URL and restart the plugin to reconnect.
- **Pairing failures**, via `/__mock/fault` on `pairing/start` or `/__mock/approve` with
  `{"deny":true}`, are shown in state `pairing_failed` (`pairing.reason` in `/status`):

| Inject                                                                             | `pairing.reason`  | Status line                                                                                                                                |
| ---------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `{"route":"pairing/start","status":503}`                                           | `unavailable`     | `VesselTwin is not available right now. Try again later.`                                                                                  |
| `{"route":"pairing/start","status":429,"retryAfter":10}`                           | `busy`            | `VesselTwin is busy. Try pairing again in a few minutes.`                                                                                  |
| `{"route":"pairing/start","status":400,"code":"integration_contract_unsupported"}` | `update_required` | `This plugin version is not supported by VesselTwin. Update the plugin.`                                                                   |
| `{"route":"pairing/start","status":400}`                                           | `rejected`        | `VesselTwin could not start pairing with this plugin. Check for a plugin update, then try again.`                                          |
| approve with `{"deny":true}`                                                       | `denied`          | `Pairing was declined in VesselTwin. Start pairing again if that was a mistake.`                                                           |
| let the code expire (10 minutes) or fault `pairing/token` with `expired_token`     | `expired`         | `The pairing code expired. Start pairing again. If this keeps happening, VesselTwin integrations may not be enabled for your account yet.` |

- **Unpair**: `curl -s -X POST -H "authorization: Bearer $T" localhost:3100/plugins/signalk-vesseltwin/unpair`
  answers `{"paired":false,"message":"Unpaired on this server. Also revoke the connection in VesselTwin so it stops working there."}`,
  `credential.json` is gone and the state is `not_paired`. The mock still holds the credential: unpair
  does not revoke it.
- **Invalid API URL**: save a config with `"apiBaseUrl":"http://example.com"` (an empty or whitespace-only value is not invalid: it means the production default).
  The state is `config_error`, `POST /pair` answers 503, and the mock log gets no new entries.

Tear down (removes the SignalK volume and with it the stored credential):

```sh
docker compose -f dev/docker-compose.yml down -v
```

## Track A: upload end to end

Checks that readings really flow from SignalK through the plugin to the mock, and that the fault paths
behave. Local only: the plugin talks to the mock at `http://localhost:3001`, never production.

**Saving the plugin settings replaces all of them**, so `node dev/setup-signalk.mjs` without
`PLUGIN_CONFIG` switches sending off again, and a restart with sending off deletes any waiting
readings. Pass the full settings every time you restart the plugin in this section:

```sh
CFG='{"uploadEnabled":true,"uploadIntervalMinutes":5,"engineHours":{"enabled":true},"batteries":{"enabled":true},"tanks":{"enabled":true}}'
pnpm build && docker compose -f dev/docker-compose.yml up -d --build
curl -s -X POST localhost:3001/__mock/reset
PLUGIN_CONFIG="$CFG" node dev/setup-signalk.mjs
node dev/pair.mjs
node dev/feed-deltas.mjs --round 1      # permitted paths AND position, MMSI, names (all fake)
```

The status line now reads `Paired with Mock Boat. Sending readings to VesselTwin.` The first send comes
one to five minutes after the plugin starts (then every `uploadIntervalMinutes`); each channel records
at most once an hour at the fastest setting, so feed new `--round N` values after an hour of mock time
or restart the plugin to record again. `GET localhost:3001/__mock/readings` shows every batch the mock
accepted: the contract header, and per reading the id, path, value and `recordedAt`.

Check:

- [ ] Every batch has `contractHeader` `2`, only permitted paths (the six shapes in `docs/api.md`), and
      `recordedAt` ending in `Z`. No `navigation`, `mmsi`, `name`, `callsign` or `design` path appears,
      and the mock log shows no other `signalk/*` route:

  ```sh
  curl -s localhost:3001/__mock/readings | node -e '
    const b=JSON.parse(require("fs").readFileSync(0,"utf8")).batches;
    const r=b.flatMap(x=>x.readings);
    console.log("contract",[...new Set(b.map(x=>x.contractHeader))],"readings",r.length);
    console.log("bad paths",r.filter(x=>/navigation|mmsi|name|callsign|design/i.test(x.path)).length);
    console.log("non-Z times",r.filter(x=>!x.recordedAt.endsWith("Z")).length)'
  ```

- [ ] Admin `/status` shows `upload.queued` 0, `upload.lastSentAt` set and `results.accepted` equal to
      the number of readings the mock holds.
- [ ] Setup prompt: `curl -s -X POST localhost:3001/__mock/summary -H 'content-type: application/json'
-d '{"channels":3,"awaitingSetup":2,"held":0}'`, restart the plugin (full `PLUGIN_CONFIG` again);
      the status line ends `Some channels need setup in VesselTwin.` and the VesselTwin page says
      `2 channels need setup in the VesselTwin app.` Clear it with `{"summary":null}`.
- [ ] 0.1.1-style settings send nothing: `PLUGIN_CONFIG='{"sendEngineHours":true,"sendBatteries":true,"sendTanks":true}'
node dev/setup-signalk.mjs`, feed deltas, wait six minutes: the mock holds no new readings, the line
      says `Sending readings is off in the plugin settings.`, and `upload.warnings` contains
      `legacy_send_settings`.

### Upload faults

Inject with `fault` on route `signalk/readings`, feed a new round so something is queued, and watch
`st` and the mock log (`mlog`; fault entries are marked). Run the ones that do not stick first.

| Inject (`route: "signalk/readings"`) | Expected                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"status":500}`                     | Readings stay queued (`upload.queued` > 0), retries back off from 5 s; after `fault clear` they go out with the same ids                     |
| `{"status":429,"retryAfter":30}`     | Backs off and does not retry before 30 s; queue kept                                                                                         |
| `{"status":413,"once":true}`         | The batch is halved and sent again; nothing is lost                                                                                          |
| `{"status":503}`                     | Paused: status line says `...will keep checking. Readings are kept for up to 7 days.`; the queue is kept; no retry for an hour               |
| `{"status":426}`                     | `update_required` (status line: `Update the plugin.`), uploading stops, the queue is kept; sticky until the plugin restarts                  |
| `{"status":401}`                     | `reauth_required` (`Pair again.`), a tombstone replaces the credential, uploading and probing stop. Pairing again starts with an empty queue |

Restart the plugin after each sticky one (`426`, `401`, and `503` if you do not want to wait an hour).

### Replay after a restart

1. `fault '{"route":"signalk/readings","status":500}'`, then `node dev/feed-deltas.mjs --round 2`.
2. Wait until `upload.queued` is above 0, and list the queued ids and paths from the container:

   ```sh
   docker exec vesseltwin-dev-signalk-1 sh -c 'cat /home/node/.signalk/plugin-config-data/signalk-vesseltwin/queue/seg-*.ndjson' \
     | node -e 'require("fs").readFileSync(0,"utf8").trim().split("\n").forEach(l=>{const r=JSON.parse(l);console.log(r.clientReadingId,r.path)})'
   ```

3. Restart the plugin with the same full `PLUGIN_CONFIG`, then `fault '{"route":"clear"}'`.
4. Within a few minutes the mock receives exactly those ids (`GET /__mock/readings`), `upload.queued`
   returns to 0, and the mock never reports one as `rejected` (`results` in `/status` shows `accepted`,
   not `duplicate` or `rejected`, for the replayed ones).

## Track B: a VesselTwin API running locally

Use this to check the plugin against the real API instead of the mock. You need an account in your
local VesselTwin web app for which the integration is enabled.

```sh
# the API listens on the host's port 3001; keep the mock off that port
RELAY_TARGET=host.docker.internal:3001 MOCK_HOST_PORT=3002 \
  docker compose -f dev/docker-compose.yml up -d --build
node dev/setup-signalk.mjs
node dev/pair.mjs --no-approve
```

`dev/pair.mjs --no-approve` starts pairing and prints the user code. Approve it yourself in the
VesselTwin web app (the connect page of your local app, signed in as that account), choosing your boat.
The script then waits for the first status check and prints the final status. If the integration is not
enabled for the account, pairing ends in `pairing_failed` with reason `unavailable` or `expired`; that
is the neutral handling working, not a plugin fault.

The plugin still talks to `http://localhost:3001` inside the container; the relay forwards that to
the host. Fault injection is not available in this track. To check unavailable handling, run the
API with the integration switched off for the account and start pairing.

## Verification checklist

After a successful pairing (either track), and before `down -v`:

- [ ] `credential.json` is mode `0600` and has an `apiOrigin` key. Print only the key names:

  ```sh
  docker exec vesseltwin-dev-signalk-1 sh -c '
    f=/home/node/.signalk/plugin-config-data/signalk-vesseltwin/credential.json
    stat -c "%a %U" $f
    node -e "console.log(Object.keys(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"))).join(\",\"))" $f'
  ```

  Expected: `600 node` and `credential,credentialId,vesselLabel,pairedAt,apiOrigin`. Do not print the
  values.

- [ ] No secret in the logs. This must print nothing:

  ```sh
  docker compose -f dev/docker-compose.yml logs 2>&1 | grep -E "vti_|deviceCode"
  ```

- [ ] The plugin settings (Server > Plugin Config) hold only the API URL and options, never the
      credential.
- [ ] Checking the settings form: sign in at `/admin/` with the rig login from `dev/README.md`, then
      open Plugin Config > VesselTwin. The record intervals default to 1440, "Record from" appears once per
      section, no description says "not active" or "future release", a bad id blocks Save, and tank ids need the form `type.id`.
- [ ] The webapp: with the plugin enabled, Webapps lists VesselTwin (with the plugin disabled it does
      not). `GET /signalk-vesseltwin/` serves the page with no login (static files only);
      `GET /plugins/signalk-vesseltwin/status` without a token still answers 401. Open
      `/signalk-vesseltwin/` in a browser signed in as admin: Pair shows the code and a link, a
      countdown runs, Cancel returns to Not paired, and Pair again plus approving on the mock ends in
      Connected. Unpair asks for a second click before it acts. Signed out, the page says to sign in as
      an administrator and links to the SignalK login. Once paired, the page lists whether
      sending is on, how many channels need setup, how many readings wait and when the last batch went
      out; there is no "upload not available" notice anywhere.
- [ ] Cancel racing an approval: if you approve in the mock (or VesselTwin) just as you press Cancel,
      the connection may be created on the VesselTwin side while the page shows Not paired. Remove it
      in VesselTwin (the plugin cannot revoke it).
- [ ] Admin auth applies to the plugin routes: `GET /plugins/signalk-vesseltwin/status` without a
      token answers 401, with the admin token 200.
- [ ] With SignalK security enabled and read-only or anonymous access allowed, confirm a non-admin
      gets 401/403 on `GET /plugins/signalk-vesseltwin/status` and `POST /pair`, and that no status
      line or log line (visible to non-admins) contains the pairing code while pairing is pending.
- [ ] The SignalK self id shape on a fresh server. `getSelfPath('uuid')` reads the server's own id;
      the same value is at `GET /signalk/v1/api/vessels/self/uuid` (admin token). Expected shape:
      `urn:mrn:signalk:uuid:<uuid>`. The plugin sends it as an optional hint only when it is a SignalK
      UUID (bare or with that prefix); a server id based on an MMSI is left out.
- [ ] Unpair removes `credential.json`, the state is `not_paired`, and the status line says to revoke
      the connection in VesselTwin too (until the next start or pairing).
- [ ] With sending off (the default), nothing else is sent: the mock log lists only `pairing/start`,
      `pairing/token` and `status` requests, and `GET /__mock/readings` is empty.
