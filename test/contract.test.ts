import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, ERROR_CODES, POLL_ERRORS, PROVIDER, SCOPES } from '../src/contract';

describe('contract constants', () => {
  it('pins the wire constants', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(PROVIDER).toBe('signalk');
    expect(SCOPES).toEqual(['meters:write', 'vessel-info:suggest']);
    expect(POLL_ERRORS).toEqual([
      'authorization_pending',
      'slow_down',
      'expired_token',
      'access_denied',
    ]);
  });

  it('pins the full platform error code list', () => {
    expect([...ERROR_CODES]).toEqual([
      'integration_feature_unavailable',
      'integration_plan_required',
      'integration_paused_plan',
      'integration_scope',
      'integration_contract_unsupported',
      'integration_scope_invalid',
      'integration_pairing_invalid',
      'integration_vessel_invalid',
      'integration_unauthorized',
      'integration_contract_required',
      'integration_rate_limited',
      'integration_credential_superseded',
    ]);
  });
});
