import { describe, expect, it } from 'vitest';
import { redact, redactError } from '../src/redact';

describe('redact', () => {
  it('removes credentials, bearer headers and device codes', () => {
    const s = redact(
      'Authorization: Bearer vti_AbCdEf123456 and vti_ZZZZZZZZZZ and "deviceCode":"abcdefghijklmnop1234"',
    );
    expect(s).not.toMatch(/AbCdEf123456|ZZZZZZZZZZ|abcdefghijklmnop1234/);
    expect(s).toContain('[redacted]');
  });
  it('redacts error messages', () => {
    expect(redactError(new Error('bad vti_AbCdEf123456'))).not.toContain('AbCdEf123456');
  });
  it('leaves harmless text alone', () => {
    expect(redact('pairing expired')).toBe('pairing expired');
  });
});
