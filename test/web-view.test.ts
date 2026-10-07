import { describe, expect, it } from 'vitest';
import {
  EXPIRED_COPY,
  GENERIC_STATUS_COPY,
  KNOWN_STATES,
  UPLOAD_NOTICE,
  actionsFor,
  cleanText,
  describeProblem,
  describeStatus,
  formatCountdown,
  parseStatus,
  remainingSeconds,
  safeVerificationUrl,
  stripUploadNotice,
} from '../web/view.js';

const BIDI = '‮';
const ZWSP = '​';

describe('safeVerificationUrl', () => {
  it('accepts https and loopback http', () => {
    expect(safeVerificationUrl('https://app.vesseltwin.io/connect?c=1')).toBe(
      'https://app.vesseltwin.io/connect?c=1',
    );
    for (const host of ['localhost:3000', '127.0.0.1:8080', '[::1]:3000']) {
      expect(safeVerificationUrl(`http://${host}/x`), host).not.toBeNull();
    }
  });
  it('rejects everything else', () => {
    const bad: unknown[] = [
      'http://example.com/x',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      'https://user:pw@example.com/',
      'https://exa mple.com/',
      `https://example.com/${BIDI}x`,
      `https://example.com/${ZWSP}x`,
      'https://example.com/\nx',
      `https://example.com/${'a'.repeat(300)}`,
      '',
      '/relative',
      42,
      null,
      undefined,
      {},
    ];
    for (const v of bad) expect(safeVerificationUrl(v), String(v)).toBeNull();
  });
});

describe('parseStatus', () => {
  const pairingBody = {
    state: 'pairing',
    paired: false,
    vesselLabel: null,
    apiOrigin: 'https://api.vesseltwin.io',
    pairing: {
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://app.vesseltwin.io/connect',
      expiresAt: '2030-01-01T00:00:00.000Z',
      expiresInSeconds: 600,
    },
    updateRecommended: false,
    clockSkewWarning: false,
    lastCheckedAt: null,
    message: 'Pairing in progress.',
  };

  it('reads the fields the page uses', () => {
    const m = parseStatus(pairingBody);
    expect(m).toMatchObject({
      state: 'pairing',
      paired: false,
      apiHint: null,
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://app.vesseltwin.io/connect',
      expiresInSeconds: 600,
      message: 'Pairing in progress.',
    });
  });
  it('shows the API origin only when it is not the default', () => {
    expect(parseStatus({ ...pairingBody, apiOrigin: 'http://localhost:3001' }).apiHint).toBe(
      'http://localhost:3001',
    );
    expect(parseStatus({ ...pairingBody, apiOrigin: null }).apiHint).toBeNull();
  });
  it('never throws on junk and maps unknown states to unknown', () => {
    for (const j of [null, undefined, 1, 'x', [], {}, { state: 'nope' }, { state: 5 }]) {
      const m = parseStatus(j);
      expect(m.state).toBe('unknown');
      expect(actionsFor(m)).toEqual([]);
      expect(describeStatus(m, null).message).toBe(GENERIC_STATUS_COPY);
    }
    expect(() => parseStatus({ state: 'pairing', pairing: 'x' })).not.toThrow();
  });
  it('drops a bad user code, an unsafe link and bad countdown values', () => {
    const m = parseStatus({
      ...pairingBody,
      pairing: { userCode: '<b>x</b>', verificationUrl: 'javascript:1', expiresInSeconds: 'soon' },
    });
    expect(m.userCode).toBeNull();
    expect(m.verificationUrl).toBeNull();
    expect(m.expiresInSeconds).toBeNull();
    expect(
      parseStatus({ ...pairingBody, pairing: { expiresInSeconds: -5 } }).expiresInSeconds,
    ).toBe(0);
  });
  it('cleans label and message text', () => {
    const m = parseStatus({
      state: 'connected',
      vesselLabel: `Boat${BIDI}\n${ZWSP}X`,
      message: `a${BIDI}b`,
    });
    expect(m.vesselLabel).toBe('Boat X');
    expect(m.message).toBe('a b');
    expect(cleanText('x'.repeat(1000)).length).toBe(400);
  });
  it('ignores pairing.expiresAt and lastCheckedAt', () => {
    const m = parseStatus({
      ...pairingBody,
      pairing: { ...pairingBody.pairing, expiresInSeconds: undefined },
    });
    expect(m.expiresInSeconds).toBeNull();
  });
});

describe('countdown', () => {
  it('counts down from the server value and never goes negative or NaN', () => {
    expect(remainingSeconds(600, 0)).toBe(600);
    expect(remainingSeconds(600, 1500)).toBe(599);
    expect(remainingSeconds(10, 10_000)).toBe(0);
    expect(remainingSeconds(10, 99_999)).toBe(0);
    expect(remainingSeconds(null, 5)).toBeNull();
    expect(remainingSeconds(Number.NaN, 5)).toBeNull();
    expect(remainingSeconds(60, Number.NaN)).toBe(60);
    expect(remainingSeconds(60, -1000)).toBe(60);
    expect(remainingSeconds(60, Number.POSITIVE_INFINITY)).toBe(60);
  });
  it('is monotonic and in range over many inputs (property style)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 500; i++) {
      const start = Math.floor(rnd() * 5000) - 100;
      const a = rnd() * 8_000_000;
      const b = a + rnd() * 1_000_000;
      const ra = remainingSeconds(start, a) ?? 0;
      const rb = remainingSeconds(start, b) ?? 0;
      expect(Number.isInteger(ra)).toBe(true);
      expect(ra).toBeGreaterThanOrEqual(0);
      expect(rb).toBeLessThanOrEqual(ra);
      const text = formatCountdown(ra);
      expect(text).toMatch(/^\d+:\d\d(:\d\d)?$/);
    }
  });
  it('formats', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(3600)).toBe('1:00:00');
    expect(formatCountdown(-4)).toBe('0:00');
    expect(formatCountdown(Number.NaN)).toBe('0:00');
  });
});

describe('describeStatus and actions', () => {
  const base = { paired: false, message: 'Hello.' };
  const model = (state: string, extra: Record<string, unknown> = {}) =>
    parseStatus({ ...base, state, ...extra });
  const ids = (state: string, extra: Record<string, unknown> = {}) =>
    actionsFor(model(state, extra)).map((a) => a.label);

  it('matches the action matrix', () => {
    expect(ids('not_paired')).toEqual(['Pair']);
    expect(ids('pairing')).toEqual(['Cancel']);
    expect(ids('checking', { paired: false })).toEqual([]);
    expect(ids('checking', { paired: true })).toEqual(['Unpair']);
    expect(ids('pairing_failed')).toEqual(['Try again']);
    for (const s of ['connected', 'paused', 'offline']) expect(ids(s)).toEqual(['Unpair']);
    expect(ids('update_required')).toEqual(['Unpair']);
    expect(ids('reauth_required')).toEqual(['Pair again', 'Unpair']);
    expect(ids('config_error')).toEqual([]);
  });
  it('covers every known state', () => {
    for (const s of KNOWN_STATES) expect(describeStatus(model(s), null).title).not.toBe('');
  });
  it('shows code, link and countdown while pairing', () => {
    const m = model('pairing', {
      pairing: {
        userCode: 'ABCD-EFGH',
        verificationUrl: 'https://app.vesseltwin.io/c',
        expiresInSeconds: 90,
      },
    });
    const s = describeStatus(m, 90);
    expect(s.code).toBe('ABCD-EFGH');
    expect(s.link).toEqual({
      href: 'https://app.vesseltwin.io/c',
      label: 'Open VesselTwin to approve',
      external: true,
    });
    expect(s.countdown).toBe('1:30');
    expect(describeStatus(m, 0).countdown).toBe(EXPIRED_COPY);
    expect(describeStatus(m, null).countdown).toBeNull();
  });
  it('never shows a code or link outside the pairing state', () => {
    const s = describeStatus(
      model('connected', { pairing: { userCode: 'ABCD-EFGH', verificationUrl: 'https://x.io/' } }),
      null,
    );
    expect(s.code).toBeNull();
    expect(s.link).toBeNull();
  });
  it('never displays the failure reason', () => {
    const m = model('pairing_failed', { pairing: { reason: 'denied' }, message: 'Declined.' });
    expect(m.failureReason).toBe('denied');
    expect(JSON.stringify(describeStatus(m, null))).not.toContain('denied');
  });
  it('links to the plugin settings on config_error and adds the Appstore hint', () => {
    expect(describeStatus(model('config_error'), null).link?.href).toBe(
      '/admin/#/serverConfiguration/plugins/signalk-vesseltwin',
    );
    expect(describeStatus(model('update_required'), null).hint).toContain('Appstore');
  });
  it('strips an exact trailing upload notice only', () => {
    expect(stripUploadNotice(`Paired. ${UPLOAD_NOTICE}`)).toBe('Paired.');
    expect(stripUploadNotice(`${UPLOAD_NOTICE} Paired.`)).toBe(`${UPLOAD_NOTICE} Paired.`);
  });
});

describe('describeProblem', () => {
  it('maps transport outcomes', () => {
    const p401 = describeProblem(401, null);
    expect(p401.kind).toBe('signin');
    expect(p401.link?.href).toBe('/admin/#/login');
    expect(p401.message).toContain('administrator');
    expect(describeProblem(403, null).message).toBe('Request not allowed.');
    expect(
      describeProblem(503, { error: 'The VesselTwin plugin is not running. Enable it first.' })
        .message,
    ).toBe('The VesselTwin plugin is not running. Enable it first.');
    for (const body of [
      null,
      {},
      { error: 5 },
      { error: 'x'.repeat(500) },
      { error: `a${BIDI}b` },
      { error: '' },
    ]) {
      expect(describeProblem(503, body).message).toBe('The plugin is not available right now.');
    }
    for (const s of [404, 500, null]) {
      expect(describeProblem(s, null)).toMatchObject({
        kind: 'unreachable',
        message: 'Cannot reach the plugin.',
      });
    }
  });
});
