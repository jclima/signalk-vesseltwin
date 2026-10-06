# Local end-to-end testing

This runs the plugin inside a stock SignalK server against a **mock** VesselTwin server on your
machine, so you can test pairing and the upload pipeline without the real platform.

> The upload pipeline is **off by default** and the released plugin does not upload anything. It
> only runs when the environment variable `VESSELTWIN_DEV_UPLOAD=1` is set (the compose file below
> sets it). The readings endpoint and body the plugin uses are a **placeholder draft**
> (`src/ingest.ts`), implemented by the mock in `dev/mock-server`. They are not the real VesselTwin
> API, which has not published its ingest contract yet.

## What you need

- Node 22+, pnpm 10, Docker (the `signalk/signalk-server` image, pulled on first run).
- Free ports `3000` (SignalK admin UI) and `4010` (mock). Set `SK_PORT=3100` to move the UI.

## Morning checklist

1. Build the plugin and start the rig:

   ```sh
   pnpm install && pnpm build
   docker compose -f dev/docker-compose.yml up -d
   ```

   Two containers start. The mock shares the SignalK container's network namespace, so inside the
   plugin `http://localhost:4010` is the mock. This is deliberate: the plugin only accepts plain
   `http://` for `localhost`, `127.0.0.1` and `[::1]`. A URL such as `http://host.docker.internal`
   is silently replaced by the production URL by the settings parser, so do not use one.

2. One-time setup (creates a throwaway admin user on the fresh test server, enables the plugin
   and points it at the mock; the generated password is kept in `.signalk-dev/`, which is
   gitignored):

   ```sh
   node dev/setup-signalk.mjs
   ```

   Expected: `plugin config saved: 200` and `plugin: {"enabled":true,...}`. You can also open
   http://localhost:3000 and look under Server > Plugin Config; the plugin is listed as
   "VesselTwin". Preflight: `docker compose -f dev/docker-compose.yml logs signalk` should not show
   errors, and the plugin settings must show API URL `http://localhost:4010`.

3. Pair. The plugin has no web page of its own yet; its router endpoints are used directly:

   ```sh
   node dev/pair.mjs            # prints: Enter code ABCD-EFGH at http://127.0.0.1:4010/connect
   curl -X POST http://127.0.0.1:4010/__debug/approve    # stands in for the owner approving
   ```

   (`node dev/pair.mjs --approve` does both.) The same text is the plugin's status line in the
   admin UI (Server > Plugin Config > VesselTwin, or the dashboard plugin status). After approval
   the status endpoint reports `"paired": true`. The mock logs `pairing started` and
   `pairing approved`.

4. Send sample data:

   ```sh
   node dev/send-sample-deltas.mjs --count 4 --interval 3
   ```

   This pushes engine run time (two engines), battery voltage and state of charge, and tank levels
   over the server's WebSocket stream, plus a position and a speed that the plugin must ignore.

5. Wait about 40 seconds (the plugin samples every 10 s and uploads every 30 s), then:

   ```sh
   curl -s http://127.0.0.1:4010/__debug/readings | python3 -m json.tool
   docker compose -f dev/docker-compose.yml logs mock
   ```

   Expected: one `batch #1 n=7 accepted=7 ...` log line and seven readings (engine, battery, tank
   paths only; run times are raw seconds, ratios are raw 0..1 values; the server converts). No
   `navigation.*` path ever appears. The first run emits everything once; later runs only emit
   what changed by at least 0.1 h (engines), 5 points or 0.3 V (levels), or after an hour/day.

6. Tear down: `docker compose -f dev/docker-compose.yml down -v` and `rm -rf .signalk-dev`.

## Fault injection

Set a fault on the mock (sticky, optional `count`), then send deltas and watch the plugin:

```sh
curl -X POST http://127.0.0.1:4010/__debug/fault -H 'content-type: application/json' \
  -d '{"fault":"503","retryAfterS":5}'        # clear with {"fault":null}
```

| Fault       | Mock answers                          | Expected plugin behaviour                                  |
| ----------- | ------------------------------------- | ---------------------------------------------------------- |
| `401`       | neutral unauthorized                  | stops, status asks you to pair again, queue kept           |
| `403`       | paused plan                           | paused status, queue kept, probes again after about 1 hour |
| `503`       | unavailable + `Retry-After`           | paused status, queue kept, retries after `Retry-After`     |
| `426`       | contract unsupported                  | stops, status asks you to update the plugin, queue kept    |
| `429`       | rate limited + `Retry-After`          | backs off at least `Retry-After`                           |
| `500`       | server error                          | exponential backoff with jitter, queue kept                |
| `slow`      | answers after `MOCK_SLOW_MS` (3 s)    | request completes (15 s client timeout)                    |
| `duplicate` | every reading reported as `duplicate` | readings are acked and removed                             |

Other debug calls: `POST /__debug/reset` (clear readings), `POST /__debug/approve` (optionally
`{"userCode":"ABCD-EFGH"}`). Mock environment switches (set before `docker compose up`):
`MOCK_INTERVAL_S` (poll interval, default 2 here), `MOCK_AUTO_APPROVE_S` (approve automatically
after N seconds), `MOCK_FAULT`. Without Docker: `pnpm dev:mock` runs the same mock on
`127.0.0.1:4010`.

## Against a real local VesselTwin API instead

Point the plugin API URL at your local API (for example `http://localhost:3001`; from the Docker
rig the API must be reachable as `localhost`, so run the plugin on the host or share the
container's network namespace). The account that will approve the pairing needs the integration
enabled and a qualifying plan on that API; otherwise pairing answers `503` and the plugin reports
that the service is unavailable. Pairing and credential handling are real. **Uploading will not
work** against the real API until it publishes the ingest contract: the placeholder endpoint does
not exist there and the plugin will report an error.

## What is not possible yet

- Real uploads, channel mapping and anything the owner sees in VesselTwin from this data.
- Testing the real ingest wire format, result codes and rate limits.
- Vessel-info suggestions.

## Unit tests

`pnpm test` covers the pipeline, the placeholder client against the mock (in process, no network),
and the pairing flow. Nothing in the test suite uses the network.
