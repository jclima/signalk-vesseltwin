#!/usr/bin/env node
// Tiny TCP forwarder (node:net only) used by dev/docker-compose.yml.
// Env: RELAY_LISTEN_PORT (3001)  RELAY_TARGET (host:port, default mock:3001)
import { connect, createServer } from 'node:net';

const listenPort = Number(process.env.RELAY_LISTEN_PORT ?? 3001);
const target = process.env.RELAY_TARGET ?? 'mock:3001';
const sep = target.lastIndexOf(':');
const targetHost = target.slice(0, sep);
const targetPort = Number(target.slice(sep + 1));
if (sep < 1 || !Number.isInteger(targetPort)) {
  console.error('[relay] RELAY_TARGET must look like host:port');
  process.exit(1);
}

createServer((client) => {
  const upstream = connect(targetPort, targetHost);
  client.pipe(upstream);
  upstream.pipe(client);
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', end);
  upstream.on('error', end);
  client.on('close', end);
  upstream.on('close', end);
}).listen(listenPort, '0.0.0.0', () => {
  console.log(`[relay] 0.0.0.0:${String(listenPort)} -> ${target}`);
});
