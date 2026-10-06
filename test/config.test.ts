import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE_URL, parseOptions } from '../src/config';

const url = (v: unknown) => parseOptions({ apiBaseUrl: v }).apiBaseUrl;
const err = (v: unknown) => parseOptions({ apiBaseUrl: v }).configError;

describe('parseOptions apiBaseUrl', () => {
  it.each([undefined, null])('treats unset %j as the production default', (v) => {
    const o = parseOptions({ apiBaseUrl: v });
    expect(o.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(o.configError).toBeNull();
  });

  it('uses the production default when the key is absent or settings are empty', () => {
    expect(parseOptions({}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(parseOptions(undefined).configError).toBeNull();
  });

  it.each([
    ['https://api.example.test', 'https://api.example.test'],
    ['https://api.example.test/', 'https://api.example.test'],
    ['https://api.example.test/base/path', 'https://api.example.test/base/path'],
    ['HTTPS://API.EXAMPLE.TEST', 'https://api.example.test'],
    ['http://localhost:3001', 'http://localhost:3001'],
    ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ['http://[::1]:3001', 'http://[::1]:3001'],
  ])('accepts %s', (input, expected) => {
    expect(url(input)).toBe(expected);
    expect(err(input)).toBeNull();
  });

  it.each([
    'http://api.example.test',
    'http://localhost.evil.test',
    'http://localhost@evil.test',
    'https://user:pw@api.example.test',
    'http://127.0.0.1.nip.io',
    'javascript:alert(1)',
    'ftp://localhost',
    'not a url',
    '',
    '   ',
    42,
    true,
    {},
    'https://api.example.test/?x=1',
    'https://api.example.test/#f',
  ])('treats a set but invalid %j as a config error, never the production default', (input) => {
    const o = parseOptions({ apiBaseUrl: input });
    expect(o.apiBaseUrl).toBeNull();
    expect(o.configError).toMatch(/API URL .* not valid/);
    expect(o.configError).not.toMatch(/api\.vesseltwin|example|evil|pw/);
  });
});

describe('parseOptions numbers and booleans', () => {
  it('clamps samplePeriodSeconds', () => {
    expect(parseOptions({ samplePeriodSeconds: 1 }).samplePeriodSeconds).toBe(10);
    expect(parseOptions({ samplePeriodSeconds: 10 ** 9 }).samplePeriodSeconds).toBe(86_400);
    expect(parseOptions({ samplePeriodSeconds: 60 }).samplePeriodSeconds).toBe(60);
  });

  it('clamps queueMaxReadings', () => {
    expect(parseOptions({ queueMaxReadings: 5 }).queueMaxReadings).toBe(1_000);
    expect(parseOptions({ queueMaxReadings: 10 ** 9 }).queueMaxReadings).toBe(50_000);
    expect(parseOptions({ queueMaxReadings: 2_000 }).queueMaxReadings).toBe(2_000);
  });

  it.each([NaN, Infinity, -Infinity, '60', null, {}])('falls back to defaults for %j', (v) => {
    const o = parseOptions({ samplePeriodSeconds: v, queueMaxReadings: v });
    expect(o.samplePeriodSeconds).toBe(300);
    expect(o.queueMaxReadings).toBe(50_000);
  });

  it('defaults and overrides booleans', () => {
    const d = parseOptions({});
    expect(d.categories).toEqual({
      engineHours: true,
      batteries: true,
      tanks: true,
      vesselInfo: false,
    });
    const o = parseOptions({
      sendEngineHours: false,
      sendBatteries: 'no',
      sendTanks: false,
      sendVesselInfo: true,
    });
    expect(o.categories).toEqual({
      engineHours: false,
      batteries: true,
      tanks: false,
      vesselInfo: true,
    });
  });

  it.each([null, undefined, 'str', 7, []])('treats %j raw as empty', (raw) => {
    expect(parseOptions(raw)).toEqual(parseOptions({}));
  });
});
