#!/usr/bin/env node
// Mock VesselTwin API for local plugin testing (test use only; see dev/README.md).
// Env: MOCK_PORT (3001) MOCK_HOST (0.0.0.0) MOCK_POLL_INTERVAL_S (5)
//      MOCK_AUTO_APPROVE_AFTER_POLLS (0 = manual approve via /__mock/approve)
//      MOCK_VERIFICATION_URL (http://localhost:3001/connect)
import { startMock } from './mock.mjs';

const port = Number(process.env.MOCK_PORT ?? 3001);
const host = process.env.MOCK_HOST ?? '0.0.0.0';
await startMock({
  host,
  port,
  pollIntervalS: Number(process.env.MOCK_POLL_INTERVAL_S ?? 5),
  autoApproveAfterPolls: Number(process.env.MOCK_AUTO_APPROVE_AFTER_POLLS ?? 0),
  ...(process.env.MOCK_VERIFICATION_URL
    ? { verificationUrl: process.env.MOCK_VERIFICATION_URL }
    : {}),
});
console.log(`[mock] VesselTwin mock listening on http://${host}:${String(port)} (test use only)`);
