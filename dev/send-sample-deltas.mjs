#!/usr/bin/env node
// Feeds realistic engine, battery and tank deltas into a running signalk-server over its
// WebSocket stream (documented: ws://<host>/signalk/v1/stream accepts delta messages from an
// authorised client; subscribe=none avoids receiving the server's own output).
// Also sends a position and a vessel name so you can confirm the plugin never forwards them.
//
// Usage: node dev/send-sample-deltas.mjs [--count 6] [--interval 3] [--step 400]
//   --step  engine run-time increase per tick in SECONDS (the plugin only forwards a change of
//           0.1 h = 360 s or more, so keep it above 360 to see every tick arrive)
// Env: SK_URL (http://localhost:3000)  SK_TOKEN (default: read .signalk-dev/token)
import { readFile } from 'node:fs/promises';

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const count = arg('count', 6);
const interval = arg('interval', 3);
const step = arg('step', 400);
const base = process.env.SK_URL ?? 'http://localhost:3000';
const token = process.env.SK_TOKEN ?? (await readFile('.signalk-dev/token', 'utf8')).trim();

const ws = new WebSocket(
  `${base.replace(/^http/, 'ws')}/signalk/v1/stream?subscribe=none&token=${token}`,
);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener(
    'error',
    () => reject(new Error('websocket connection failed (token/URL?)')),
    {
      once: true,
    },
  );
});

let portRun = 123 * 3600; // seconds
let stbdRun = 98 * 3600;
for (let i = 0; i < count; i++) {
  portRun += step;
  stbdRun += step;
  const delta = {
    context: 'vessels.self',
    updates: [
      {
        source: { label: 'vesseltwin-dev-sample', type: 'dev' },
        timestamp: new Date().toISOString(),
        values: [
          { path: 'propulsion.port.runTime', value: portRun },
          { path: 'propulsion.starboard.runTime', value: stbdRun },
          { path: 'electrical.batteries.house.voltage', value: 12.6 + 0.5 * (i % 2) },
          { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.9 - 0.02 * i },
          { path: 'tanks.fuel.0.currentLevel', value: 0.75 - 0.01 * i },
          { path: 'tanks.fuel.0.currentVolume', value: 0.3 - 0.004 * i },
          { path: 'tanks.freshWater.0.currentLevel', value: 0.6 },
          // Never forwarded by the plugin:
          { path: 'navigation.position', value: { latitude: 0, longitude: 0 } },
          { path: 'navigation.speedOverGround', value: 2.5 },
        ],
      },
    ],
  };
  ws.send(JSON.stringify(delta));
  console.log(
    `sent delta ${String(i + 1)}/${String(count)} (port engine ${(portRun / 3600).toFixed(2)} h)`,
  );
  if (i < count - 1) await new Promise((r) => setTimeout(r, interval * 1000));
}
ws.close();
