#!/usr/bin/env node
// Drives pairing through the plugin's own endpoints. Zero dependencies.
//
//   node dev/pair.mjs               start pairing, approve it on the MOCK, wait for the first status check
//   node dev/pair.mjs --no-approve  start pairing and wait; approve elsewhere (a real API)
//
// Needs the token saved by dev/setup-signalk.mjs (.signalk-dev/token) or SK_TOKEN.
// Env: SK_PORT (3100)  SK_URL  SK_TOKEN  MOCK_URL (http://localhost:3001)  PAIR_TIMEOUT_S (90)
// Prints status JSON from the plugin. Any credential-looking field is masked before printing.
import { readFile } from 'node:fs/promises';

const sk = process.env.SK_URL ?? `http://localhost:${process.env.SK_PORT ?? '3100'}`;
const mock = process.env.MOCK_URL ?? 'http://localhost:3001';
const timeoutS = Number(process.env.PAIR_TIMEOUT_S ?? 90);
const approve = !process.argv.includes('--no-approve');

const token = (
  process.env.SK_TOKEN ?? (await readFile('.signalk-dev/token', 'utf8').catch(() => ''))
).trim();
if (!token) {
  console.error('No token. Run `node dev/setup-signalk.mjs` first.');
  process.exit(1);
}
const h = { authorization: `Bearer ${token}` };
const plugin = `${sk}/plugins/signalk-vesseltwin`;

const SECRET_KEY = /credential|device.?code|authorization|token|secret/i;
const mask = (v) =>
  Array.isArray(v)
    ? v.map(mask)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[masked]' : mask(x)]),
        )
      : v;

const get = async () => {
  const r = await fetch(`${plugin}/status`, { headers: h });
  if (!r.ok) throw new Error(`GET /status failed (${String(r.status)})`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET /status returns { state, paired, vesselLabel, apiOrigin, pairing, updateRecommended,
// clockSkewWarning, lastCheckedAt, message }. `pairing` is { userCode, verificationUrl, expiresAt }
// in state "pairing" and { reason } in state "pairing_failed".
const start = await fetch(`${plugin}/pair`, { method: 'POST', headers: h });
console.log('POST /pair:', start.status);
if (!start.ok) {
  console.log('response:', await start.text());
  process.exit(1);
}

let s = await get();
const deadline = Date.now() + timeoutS * 1000;
let announced = false;
let seenPairing = false;
// Done once pairing has been seen and the plugin moved on: "checking" is the first probe in flight.
const settled = (x) => seenPairing && !['pairing', 'checking', 'not_paired'].includes(x.state);
while (Date.now() < deadline && !settled(s)) {
  if (s.state === 'pairing_failed' || s.state === 'config_error') break;
  const code = s.state === 'pairing' ? s.pairing?.userCode : undefined;
  if (code) seenPairing = true;
  if (code && !announced) {
    console.log('pending status:', JSON.stringify(mask(s)));
    if (approve) {
      const r = await fetch(`${mock}/__mock/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: code }),
      });
      console.log('mock approve:', r.status, await r.text());
    } else {
      console.log(`Approve user code ${code} in the VesselTwin web app, then wait.`);
    }
    announced = true; // print once
  }
  await sleep(1000);
  s = await get();
  if (s.state === 'pairing' && s.pairing?.userCode) seenPairing = true;
}
console.log('final status:', JSON.stringify(mask(s)));
const ok = settled(s) && s.paired === true;
console.log(ok ? `PAIRED (state: ${s.state})` : `NOT PAIRED (state: ${s.state})`);
process.exit(ok ? 0 : 1);
