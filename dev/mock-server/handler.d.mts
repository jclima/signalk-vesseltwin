export interface MockRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export interface MockOptions {
  now?: () => number;
  intervalS?: number;
  autoApproveS?: number;
  fault?: string | null;
  retryAfterS?: number;
  slowMs?: number;
  log?: (s: string) => void;
  verificationUrl?: string;
}
export const FAULTS: string[];
export function createMock(opts?: MockOptions): {
  handle(req: MockRequest): Promise<MockResponse>;
  approve(code?: string): number;
  state: { readings: unknown[]; batches: number };
};
