#!/usr/bin/env node
// Feeds the rig's SignalK server with deltas over its WebSocket stream, for the upload e2e
// (docs/TESTING.md). Zero dependencies (needs a Node with a global WebSocket, Node >= 22).
//
//   node dev/feed-deltas.mjs                 one round: permitted AND forbidden paths
//   node dev/feed-deltas.mjs --round 3       the value for round 3 (run times grow by 1 h per round,
//                                            voltages and levels move), so a later round records again
//   node dev/feed-deltas.mjs --only permitted | --only forbidden
//   node dev/feed-deltas.mjs --suffix a      permitted instances become main-a, house-a, fuel.0-a, ...
//                                            (a channel records at most once an hour, so a new suffix
//                                            gives new channels and a reading right away)
//
// The permitted paths are the ones the plugin may send. The forbidden ones (position, MMSI, names,
// callsign, design, course) are fed on purpose so you can confirm they never reach the mock; all of
// their values are obvious fakes. Local rig only: it refuses any host that is not loopback.
//
// Auth: the bearer token saved by dev/setup-signalk.mjs (.signalk-dev/token) or SK_TOKEN, sent as an
// Authorization header. With SignalK security disabled set SK_NO_AUTH=1.
// Env: SK_PORT (3100)  SK_URL (ws or http URL of the server)  SK_TOKEN
import { readFile } from 'node:fs/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? '');
};
const round = Number(flag('--round') ?? 1);
const only = flag('--only');
const suffix = flag('--suffix');
if (suffix !== null && !/^[A-Za-z0-9_]{1,10}$/.test(suffix)) {
  console.error('--suffix must be 1 to 10 letters, digits or underscores');
  process.exit(1);
}
if (
  !Number.isInteger(round) ||
  round < 1 ||
  (only !== null && !['permitted', 'forbidden'].includes(only))
) {
  console.error(
    'usage: node dev/feed-deltas.mjs [--round N] [--suffix X] [--only permitted|forbidden]',
  );
  process.exit(1);
}

const base = new URL(process.env.SK_URL ?? `http://localhost:${process.env.SK_PORT ?? '3100'}`);
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  console.error('refusing to feed a server that is not on localhost');
  process.exit(1);
}
const noAuth = process.env.SK_NO_AUTH === '1';
const token = (
  process.env.SK_TOKEN ?? (await readFile('.signalk-dev/token', 'utf8').catch(() => ''))
).trim();
if (!token && !noAuth) {
  console.error(
    'No token. Run `node dev/setup-signalk.mjs` first (or SK_NO_AUTH=1 with security off).',
  );
  process.exit(1);
}

const sfx = suffix === null ? '' : `-${suffix}`;
const PERMITTED = [
  [`propulsion.main${sfx}.runTime`, 3_600_000 + 3600 * round],
  [`propulsion.port${sfx}.runTime`, 1_800_000 + 3600 * round],
  [`electrical.generators.gen1${sfx}.runTime`, 360_000 + 3600 * round],
  [`electrical.batteries.house${sfx}.voltage`, 12.4 + 0.1 * round],
  [`electrical.batteries.house${sfx}.capacity.stateOfCharge`, Math.min(1, 0.5 + 0.05 * round)],
  [`electrical.batteries.start${sfx}.voltage`, 12.6 + 0.1 * round],
  [`tanks.fuel.0${sfx}.currentLevel`, Math.max(0, 0.9 - 0.1 * round)],
  [`tanks.fuel.0${sfx}.currentVolume`, Math.max(0, 0.09 - 0.01 * round)],
  [`tanks.freshWater.0${sfx}.currentLevel`, Math.max(0, 0.8 - 0.1 * round)],
];
// Obvious fakes. None of these may ever be sent.
const FORBIDDEN = [
  ['navigation.position', { latitude: 1.0, longitude: 1.0 }],
  ['navigation.courseOverGroundTrue', 1.5],
  ['mmsi', '000000000'],
  ['name', 'FAKE BOAT'],
  ['communication.callsignVhf', 'FAKE1'],
  ['design.length', { overall: { value: 12 } }],
];

const wanted = [
  ...(only === 'forbidden' ? [] : PERMITTED),
  ...(only === 'permitted' ? [] : FORBIDDEN),
];
const timestamp = new Date().toISOString();
const delta = {
  context: 'vessels.self',
  updates: wanted.map(([path, value]) => ({ timestamp, values: [{ path, value }] })),
};

// The undici WebSocket accepts request headers as a second argument (a non-standard extension).
// Not a declared lint global: read it from the Node runtime (Node >= 22).
const { WebSocket } = globalThis;
const ws = new WebSocket(
  `ws://${base.host}/signalk/v1/stream?subscribe=none`,
  noAuth ? undefined : { headers: { authorization: `Bearer ${token}` } },
);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const timer = setTimeout(() => fail('timed out talking to the SignalK stream'), 15_000);
ws.onopen = () => {
  ws.send(JSON.stringify(delta));
  // The server has no acknowledgement for deltas; give it a moment to apply the update.
  setTimeout(() => {
    clearTimeout(timer);
    ws.close();
  }, 1500);
};
ws.onerror = () =>
  fail('could not connect to the SignalK stream (is the rig up, and is the token valid?)');
ws.onclose = () => {
  console.log(
    `round ${String(round)}: sent ${String(wanted.length)} updates (${String(only ?? 'permitted + forbidden')})`,
  );
  process.exit(0);
};
