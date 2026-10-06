#!/usr/bin/env node
// One-time setup for the local test rig (dev/docker-compose.yml): creates a throwaway admin
// user on the fresh test server, enables the plugin and points it at the mock server.
// The generated password is stored in .signalk-dev/admin-password (gitignored).
// Usage: node dev/setup-signalk.mjs   (env: SK_URL=http://localhost:3000)
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = process.env.SK_URL ?? 'http://localhost:3000';
const pwFile = '.signalk-dev/admin-password';
const json = { 'content-type': 'application/json' };

async function password() {
  try {
    return (await readFile(pwFile, 'utf8')).trim();
  } catch {
    const pw = randomBytes(9).toString('base64url');
    await mkdir('.signalk-dev', { recursive: true });
    await writeFile(pwFile, pw, { mode: 0o600 });
    return pw;
  }
}

const status = await (await fetch(`${base}/skServer/loginStatus`)).json();
const pw = await password();
if (status.noUsers) {
  const r = await fetch(`${base}/skServer/enableSecurity`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ userId: 'admin', password: pw, type: 'admin' }),
  });
  console.log('enable security:', r.status);
}
const login = await fetch(`${base}/signalk/v1/auth/login`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ username: 'admin', password: pw }),
});
if (!login.ok)
  throw new Error(`login failed (${String(login.status)}); delete the volume and retry`);
const { token } = await login.json();
await writeFile('.signalk-dev/token', token, { mode: 0o600 });
const auth = { ...json, authorization: `Bearer ${token}` };
const cfg = await fetch(`${base}/skServer/plugins/signalk-vesseltwin/config`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    enabled: true,
    configuration: { apiBaseUrl: 'http://localhost:4010', samplePeriodSeconds: 10 },
  }),
});
console.log('plugin config saved:', cfg.status);
const plugins = await (await fetch(`${base}/skServer/plugins`, { headers: auth })).json();
const ours = plugins.find((p) => p.id === 'signalk-vesseltwin');
console.log(
  'plugin:',
  ours
    ? JSON.stringify({ enabled: ours.data?.enabled, statusMessage: ours.statusMessage })
    : 'NOT FOUND',
);
console.log(`admin user: admin   password file: ${pwFile}`);
