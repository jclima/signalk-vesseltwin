import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids';

describe('uuidv7', () => {
  it('has the v7 format, version and variant bits', () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv7();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const hex = id.replace(/-/g, '');
      expect(parseInt(hex[12] ?? '', 16)).toBe(7);
      expect(parseInt(hex[16] ?? '', 16) & 0b1100).toBe(0b1000);
    }
  });

  it('encodes the injected time in the first 48 bits', () => {
    const now = 1_760_000_000_123;
    const hex = uuidv7(now).replace(/-/g, '');
    expect(parseInt(hex.slice(0, 12), 16)).toBe(now);
  });

  it('sorts lexicographically by time', () => {
    const times = [1_000, 1_001, 5_000, 1_700_000_000_000, 1_700_000_000_001];
    const ids = times.map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('is unique across many ids at the same time', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => uuidv7(42)));
    expect(ids.size).toBe(5_000);
  });
});
