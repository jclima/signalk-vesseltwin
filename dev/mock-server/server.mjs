#!/usr/bin/env node
// Usage: node dev/mock-server/server.mjs
// Env: MOCK_HOST (127.0.0.1) MOCK_PORT (4010) MOCK_INTERVAL_S (5) MOCK_AUTO_APPROVE_S (0 = manual)
//      MOCK_FAULT (401|403|500|503|426|429|slow|duplicate) MOCK_RETRY_AFTER_S (5) MOCK_SLOW_MS (3000)
import { createServer } from 'node:http';
import { createMock } from './handler.mjs';

const host = process.env.MOCK_HOST ?? '127.0.0.1';
const port = Number(process.env.MOCK_PORT ?? 4010);
const stamp = () => new Date().toISOString().slice(11, 19);
const mock = createMock({
  intervalS: Number(process.env.MOCK_INTERVAL_S ?? 5),
  autoApproveS: Number(process.env.MOCK_AUTO_APPROVE_S ?? 0),
  fault: process.env.MOCK_FAULT || null,
  retryAfterS: Number(process.env.MOCK_RETRY_AFTER_S ?? 5),
  slowMs: Number(process.env.MOCK_SLOW_MS ?? 3000),
  verificationUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${String(port)}/connect`,
  log: (s) => {
    console.log(`[mock ${stamp()}] ${s}`);
  },
});

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = null;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end('{"message":"Invalid JSON"}');
        return;
      }
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const out = await mock.handle({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers,
      body,
    });
    res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
    res.end(JSON.stringify(out.body));
  });
}).listen(port, host, () => {
  console.log(`[mock] VesselTwin mock listening on http://${host}:${String(port)} (test use only)`);
  console.log(
    '[mock] approve a pairing: curl -X POST http://127.0.0.1:' + String(port) + '/__debug/approve',
  );
});
