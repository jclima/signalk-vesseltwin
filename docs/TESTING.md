# Testing the plugin in a real SignalK server

Unit tests (`pnpm test`) never touch the network. This page is for manual runs of the built plugin in
a stock signalk-server, against either a mock VesselTwin API (Track A) or a VesselTwin API you run
locally (Track B). The rig lives in `dev/` (see [dev/README.md](../dev/README.md)); it is for testing
only and is not published to npm. Never point tests at production.

Needs Docker and Node >= 22. Run everything from the repository root.

## How you drive the plugin

- The plugin has no page or button. Pairing starts with `POST /plugins/signalk-vesseltwin/pair`
  (`node dev/pair.mjs` does this). The code appears in the plugin's status line (SignalK admin UI,
  Server > Plugin Config) and in `GET /plugins/signalk-vesseltwin/status` under `pairing.userCode`.
- These routes sit behind the server's admin login. `node dev/setup-signalk.mjs` creates a throwaway
  admin, saves a bearer token to `.signalk-dev/token` (gitignored) and enables the plugin.
- Handy shell helpers used below:

```sh
T=$(cat .signalk-dev/token)
st()   { curl -s -H "authorization: Bearer $T" localhost:3100/plugins/signalk-vesseltwin/status; echo; }
fault(){ curl -s -X POST localhost:3001/__mock/fault -H 'content-type: application/json' -d "$1"; echo; }
mlog() { curl -s localhost:3001/__mock/log; echo; }   # method, path, status, time; never codes or credentials
```

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

`dev/pair.mjs` starts pairing, prints the pending status (with `pairing.userCode`), approves that code
on the mock, then waits for the first status check. Expected end:

```
final status: {"state":"connected","paired":true,"vesselLabel":"Mock Boat", ... "pairing":null, ...}
PAIRED (state: connected)
```

The status line (admin UI) reads `Paired with Mock Boat. Data upload is not available in this
version.` The mock log shows `POST pairing/start`, `POST pairing/token`, then `GET status` (200, with
auth).

### Fault injections

Inject with `fault`, restart the plugin (see above), then check `st` and `mlog`. Clear with
`fault '{"route":"clear"}'`. Full option list: [dev/README.md](../dev/README.md).

| Inject (`route: "status"`)                          | Expected `state`  | Status line (after `Paired with Mock Boat.`)                                                                 |
| --------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `{"status":503}`                                    | `paused`          | `VesselTwin integrations are not available for your account right now. The plugin will keep checking. ...`   |
| `{"status":403}`                                    | `paused`          | `The connection is paused for your VesselTwin plan. The plugin will keep checking. ...`                      |
| `{"status":200,"minContract":2}`                    | `update_required` | `This plugin version is not supported by VesselTwin. Update the plugin. ...`                                 |
| `{"status":426,"minContract":2}`                    | `update_required` | same as above                                                                                                |
| `{"status":401}`                                    | `reauth_required` | `Pairing with VesselTwin is no longer valid. Pair again from the plugin page. ...` (no `Paired with` prefix) |
| `{"status":429,"retryAfter":30}` or `5xx`           | `offline`         | `Cannot reach VesselTwin right now. The plugin will keep trying. ...`                                        |
| `{"status":200,"minContract":1,"latestContract":2}` | `connected`       | `A plugin update is available.` before the upload note; `updateRecommended` is `true`                        |

Every line also ends with `Data upload is not available in this version.` unless noted.

Details worth checking:

- **503 with `Retry-After`**: the mock defaults `Retry-After` to 3600. The state is `paused`, and the
  mock log shows no further `GET status` until at least `Retry-After` (never sooner than an hour in
  any case). Wait a minute or so and confirm the log has not grown.
- **401**: `paired` is `false`, but `credential.json` stays on disk. After another plugin restart the
  log shows at most one more `GET status` (401) and then nothing; there is no retry loop. Clear the
  fault and run `node dev/pair.mjs` again: pairing is allowed in `reauth_required`, overwrites the
  credential and ends in `connected`.
- **Origin binding**: change the plugin's `apiBaseUrl` to a different local origin (for example
  `http://127.0.0.1:3001`, which the relay does not serve) while a credential exists: the state is
  `reauth_required` and the mock log shows no request at all.
- **Pairing failures**, via `/__mock/fault` on `pairing/start` or `/__mock/approve` with
  `{"deny":true}`, are shown in state `pairing_failed` (`pairing.reason` in `/status`):

| Inject                                                                             | `pairing.reason`  | Status line                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"route":"pairing/start","status":503}`                                           | `unavailable`     | `VesselTwin is not available right now. Try again later.`                                                                                                       |
| `{"route":"pairing/start","status":429,"retryAfter":10}`                           | `busy`            | `VesselTwin is busy. Try pairing again in a few minutes.`                                                                                                       |
| `{"route":"pairing/start","status":400,"code":"integration_contract_unsupported"}` | `update_required` | `This plugin version is not supported by VesselTwin. Update the plugin.`                                                                                        |
| `{"route":"pairing/start","status":400}`                                           | `rejected`        | `VesselTwin could not start pairing with this plugin. Check for a plugin update, then try again.`                                                               |
| approve with `{"deny":true}`                                                       | `denied`          | `Pairing was declined in VesselTwin. Start again from the plugin page if that was a mistake.`                                                                   |
| let the code expire (10 minutes) or fault `pairing/token` with `expired_token`     | `expired`         | `The pairing code expired. Start pairing again from the plugin page. If this keeps happening, VesselTwin integrations may not be enabled for your account yet.` |

- **Unpair**: `curl -s -X POST -H "authorization: Bearer $T" localhost:3100/plugins/signalk-vesseltwin/unpair`
  answers `{"paired":false,"message":"Unpaired on this server. Also revoke the connection in VesselTwin so it stops working there."}`,
  `credential.json` is gone and the state is `not_paired`. The mock still holds the credential: unpair
  does not revoke it.
- **Invalid API URL**: save a config with `"apiBaseUrl":"http://example.com"` (or an empty string).
  The state is `config_error`, `POST /pair` answers 503, and the mock log gets no new entries.

Tear down (removes the SignalK volume and with it the stored credential):

```sh
docker compose -f dev/docker-compose.yml down -v
```

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
- [ ] Admin auth applies to the plugin routes: `GET /plugins/signalk-vesseltwin/status` without a
      token answers 401, with the admin token 200.
- [ ] The SignalK self id shape on a fresh server. `getSelfPath('uuid')` reads the server's own id;
      the same value is at `GET /signalk/v1/api/vessels/self/uuid` (admin token). Expected shape:
      `urn:mrn:signalk:uuid:<uuid>`. The plugin sends it as an optional hint only when it is a SignalK
      UUID (bare or with that prefix); a server id based on an MMSI is left out.
- [ ] Unpair removes `credential.json`, the state is `not_paired`, and the status line says to revoke
      the connection in VesselTwin too.
- [ ] Nothing else is sent: the mock log lists only `pairing/start`, `pairing/token` and `status`
      requests.
