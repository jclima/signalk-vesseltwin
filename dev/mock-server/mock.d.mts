import type { Server } from 'node:http';

export interface MockOptions {
  pollIntervalS?: number;
  autoApproveAfterPolls?: number;
  verificationUrl?: string;
  now?: () => number;
}
export interface StartMockOptions extends MockOptions {
  host?: string;
  port?: number;
}
export function startMock(options?: StartMockOptions): Promise<Server>;
