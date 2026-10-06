/**
 * Wire contract constants. Mirror of the platform envelope in VesselTwin's
 * `packages/types/src/integrations.ts` (shapes only; no code is shared).
 * The JSON Schema for the ingest contract is published with M2 (see docs/contract.md).
 */

export const PROVIDER = 'signalk' as const;
/** Sent as `X-VesselTwin-Contract`. Server supports a window [min, latest]. */
export const CONTRACT_VERSION = 1;
export const SCOPES = ['meters:write', 'vessel-info:suggest'] as const;
export type Scope = (typeof SCOPES)[number];

export const POLL_ERRORS = [
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
] as const;
export type PollError = (typeof POLL_ERRORS)[number];

/** Machine-readable `integration_*` codes the server may return. */
export const ERROR_CODES = [
  'integration_feature_unavailable',
  'integration_plan_required',
  'integration_paused_plan',
  'integration_scope',
  'integration_contract_unsupported',
  'integration_scope_invalid',
  'integration_pairing_invalid',
  'integration_vessel_invalid',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PairingStartRequest {
  provider: typeof PROVIDER;
  clientName: string;
  clientVersion: string;
  contractVersion: number;
  deviceLabel: string;
  requestedScopes: Scope[];
  providerHints?: { signalkSelfUuid?: string };
}

export interface PairingStartResponse {
  deviceCode: string;
  /** Display form `ABCD-EFGH`. */
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}

export interface PairingTokenResponse {
  /** Plaintext `vti_...`, returned once. */
  credential: string;
  credentialId: string;
  scopes: Scope[];
  vesselLabel: string | null;
  provider: string;
}

export interface Reading {
  clientReadingId: string;
  path: string;
  value: number;
  recordedAt: string;
}
