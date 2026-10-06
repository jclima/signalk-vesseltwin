#!/usr/bin/env node
// Starts pairing through the plugin's own endpoint and shows what the owner would see.
// Usage: node dev/pair.mjs [--approve]
//   --approve  also approves the pairing on the MOCK server (stands in for the owner typing the
//              code into the VesselTwin web app). Without it, approve with:
//              curl -X POST http://127.0.0.1:4010/__debug/approve
// Env: SK_URL (http://localhost:3000), MOCK_URL (http://127.0.0.1:4010)
import { readFile } from 'node:fs/promises';

const sk = process.env.SK_URL ?? 'http://localhost:3000';
const mock = process.env.MOCK_URL ?? 'http://127.0.0.1:4010';
const token = (await readFile('.signalk-dev/token', 'utf8')).trim();
const h = { authorization: `Bearer ${token}` };
const get = async () =>
  (await fetch(`${sk}/plugins/signalk-vesseltwin/status`, { headers: h })).json();

console.log(
  'start:',
  (await fetch(`${sk}/plugins/signalk-vesseltwin/pair`, { method: 'POST', headers: h })).status,
);
let s = await get();
for (let i = 0; i < 20 && !s.pairing && !s.paired; i++) {
  await new Promise((r) => setTimeout(r, 500));
  s = await get();
}
if (s.pairing) console.log(`Enter code ${s.pairing.userCode} at ${s.pairing.verificationUrl}`);
if (process.argv.includes('--approve')) {
  console.log(
    'mock approve:',
    await (await fetch(`${mock}/__debug/approve`, { method: 'POST' })).text(),
  );
}
for (let i = 0; i < 60 && !s.paired; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  s = await get();
}
console.log(s.paired ? 'paired' : 'not paired yet (still waiting)');
