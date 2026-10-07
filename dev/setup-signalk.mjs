#!/usr/bin/env node
// One-time setup for the local rig (dev/docker-compose.yml). Zero dependencies.
//
// Against the SignalK server at http://localhost:${SK_PORT:-3100} it creates the throwaway dev
// admin (or logs in if it already exists), enables the plugin, sets apiBaseUrl to
// http://localhost:3001 (the relay inside the container forwards it), and saves an admin token for
// later calls to .signalk-dev/token (gitignored, file 0600, directory 0700). The token is never printed.
//
// Env: SK_PORT (3100)  SK_URL (overrides the URL)  SK_ADMIN_USER (dev-admin)
//      SK_ADMIN_PASSWORD (dev-admin-password)  PLUGIN_API_URL (http://localhost:3001)
// Developed against signalk-server 2.33.0 (the image tag pinned in docker-compose.yml).
import { saveToken } from './token-store.mjs';

const base = process.env.SK_URL ?? `http://localhost:${process.env.SK_PORT ?? '3100'}`;
const user = process.env.SK_ADMIN_USER ?? 'dev-admin';
const password = process.env.SK_ADMIN_PASSWORD ?? 'dev-admin-password'; // fake, local rig only
const apiBaseUrl = process.env.PLUGIN_API_URL ?? 'http://localhost:3001';
const json = { 'content-type': 'application/json' };

async function login() {
  return fetch(`${base}/signalk/v1/auth/login`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ username: user, password }),
  });
}

let status;
try {
  status = await (await fetch(`${base}/skServer/loginStatus`)).json();
} catch {
  console.error(`SignalK server not reachable at ${base}. Is the rig up? (see dev/README.md)`);
  process.exit(1);
}
if (status.noUsers) {
  const r = await fetch(`${base}/skServer/enableSecurity`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ userId: user, password, type: 'admin' }),
  });
  console.log('create admin user:', r.status);
}
let res = await login();
// Security is applied at the next request cycle on some versions; retry briefly.
for (let i = 0; i < 10 && !res.ok; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  res = await login();
}
if (!res.ok) {
  console.error(
    `login failed (${String(res.status)}). The volume may hold a different admin; run ` +
      '`docker compose -f dev/docker-compose.yml down -v` and retry, or set SK_ADMIN_USER / SK_ADMIN_PASSWORD.',
  );
  process.exit(1);
}
const { token } = await res.json();
await saveToken('.signalk-dev', token); // dir 0700, file 0600, tightened if they already exist

const auth = { ...json, authorization: `Bearer ${token}` };
const cfg = await fetch(`${base}/skServer/plugins/signalk-vesseltwin/config`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ enabled: true, configuration: { apiBaseUrl } }),
});
console.log('plugin config saved:', cfg.status);

const plugins = await (await fetch(`${base}/skServer/plugins`, { headers: auth })).json();
const ours = plugins.find((p) => p.id === 'signalk-vesseltwin');
console.log(
  'plugin:',
  ours
    ? JSON.stringify({ enabled: ours.data?.enabled, statusMessage: ours.statusMessage })
    : 'NOT FOUND (is the plugin built? run pnpm build, then restart the signalk container)',
);
console.log(`apiBaseUrl: ${apiBaseUrl}`);
console.log(`admin user: ${user}`);
console.log('admin token saved to .signalk-dev/token (mode 0600, not printed)');
