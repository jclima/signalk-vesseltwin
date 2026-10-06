// Mock VesselTwin integrations server for local testing. Zero dependencies.
// NOT the real platform: the readings route and body are a DRAFT matching the
// plugin's placeholder transport (see src/ingest.ts). Never run this in production.
import { randomBytes, randomUUID } from 'node:crypto';

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONTRACT = { min: 1, latest: 1 };
const ID = '[A-Za-z0-9_-]{1,40}';
const TYPES = 'fuel|freshWater|wasteWater|blackWater|lubrication|liveWell|baitWell|gas|ballast';
const PATH_RE = new RegExp(
  `^(propulsion\\.${ID}\\.runTime|electrical\\.generators\\.${ID}\\.runTime|electrical\\.batteries\\.${ID}\\.(voltage|capacity\\.stateOfCharge)|tanks\\.(${TYPES})\\.${ID}\\.(currentLevel|currentVolume))$`,
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FAULTS = ['401', '403', '500', '503', '426', '429', 'slow', 'duplicate'];

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'cache-control': 'no-store', ...headers },
  body,
});
const err = (status, code, message, extra = {}, headers = {}) =>
  json(status, { code, message, ...extra }, headers);

const userCode = () => {
  let c = '';
  const b = randomBytes(8);
  for (const x of b) c += USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};
const credential = () => `vti_${randomBytes(32).toString('base64url')}`;

/**
 * @param {{ now?: () => number, intervalS?: number, autoApproveS?: number,
 *   fault?: string|null, retryAfterS?: number, slowMs?: number, log?: (s:string)=>void,
 *   verificationUrl?: string }} [opts]
 */
export function createMock(opts = {}) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const intervalS = opts.intervalS ?? 5;
  const state = {
    pairings: new Map(), // deviceCode -> {userCode, status, createdAt, lastPoll}
    credentials: new Map(), // plaintext -> {id, expiresAt|null, superseded}
    readings: [],
    seen: new Set(),
    batches: 0,
    fault: opts.fault ?? null,
    faultCount: Infinity,
    retryAfterS: opts.retryAfterS ?? 5,
    slowMs: opts.slowMs ?? 3000,
  };

  function approve(code) {
    let n = 0;
    for (const p of state.pairings.values()) {
      if (p.status === 'pending' && (!code || p.userCode === code.toUpperCase())) {
        p.status = 'approved';
        n += 1;
      }
    }
    return n;
  }

  function auth(headers) {
    const raw = headers.authorization ?? '';
    const m = /^Bearer (vti_[A-Za-z0-9_-]{43})$/.exec(raw);
    const rec = m ? state.credentials.get(m[1]) : undefined;
    if (!rec || (rec.expiresAt !== null && rec.expiresAt <= now())) {
      return {
        deny: err(
          401,
          'integration_unauthorized',
          'Unauthorized.',
          {},
          { 'www-authenticate': 'Bearer' },
        ),
      };
    }
    return { rec };
  }

  function contractCheck(headers) {
    const raw = headers['x-vesseltwin-contract'];
    if (raw === undefined || !/^\d+$/.test(raw)) {
      return err(400, 'integration_contract_required', 'Contract version required.', {
        minContract: CONTRACT.min,
        latestContract: CONTRACT.latest,
      });
    }
    const v = Number(raw);
    if (v < CONTRACT.min || v > CONTRACT.latest) {
      return err(426, 'integration_contract_unsupported', 'Update required.', {
        minContract: CONTRACT.min,
        latestContract: CONTRACT.latest,
      });
    }
    return null;
  }

  function injected(query) {
    const f = query.get('fault') ?? state.fault;
    if (!f) return null;
    if (query.get('fault') === null) {
      if (state.faultCount <= 0) return null;
      state.faultCount -= 1;
    }
    return f;
  }

  /** @returns {Promise<{status:number, headers:object, body:unknown}>} */
  async function handle({ method, url, headers = {}, body = null }) {
    const u = new URL(url, 'http://mock.local');
    const p = u.pathname;
    const q = u.searchParams;

    if (p === '/__debug/readings' && method === 'GET') {
      return json(200, {
        count: state.readings.length,
        batches: state.batches,
        readings: state.readings,
      });
    }
    if (p === '/__debug/approve' && method === 'POST') {
      return json(200, { approved: approve(body?.userCode) });
    }
    if (p === '/__debug/fault' && method === 'POST') {
      const f = body?.fault ?? null;
      if (f !== null && !FAULTS.includes(f))
        return json(400, { message: 'unknown fault', faults: FAULTS });
      state.fault = f;
      state.faultCount = typeof body?.count === 'number' ? body.count : Infinity;
      if (typeof body?.retryAfterS === 'number') state.retryAfterS = body.retryAfterS;
      return json(200, {
        fault: state.fault,
        count: state.faultCount === Infinity ? null : state.faultCount,
      });
    }
    if (p === '/__debug/reset' && method === 'POST') {
      state.readings = [];
      state.seen.clear();
      state.batches = 0;
      state.fault = null;
      return json(200, { ok: true });
    }

    if (p === '/v1/integrations/pairing/start' && method === 'POST') {
      if (!body || body.provider !== 'signalk' || !Array.isArray(body.requestedScopes)) {
        return json(400, { message: 'Validation failed', errors: [] });
      }
      const deviceCode = randomBytes(32).toString('base64url');
      const uc = userCode();
      state.pairings.set(deviceCode, {
        userCode: uc,
        status: 'pending',
        createdAt: now(),
        lastPoll: 0,
      });
      log(`pairing started: user code ${uc} (approve: POST /__debug/approve)`);
      return json(200, {
        deviceCode,
        userCode: uc,
        verificationUrl: opts.verificationUrl ?? 'http://127.0.0.1:4010/connect',
        interval: intervalS,
        expiresIn: 600,
      });
    }

    if (p === '/v1/integrations/pairing/token' && method === 'POST') {
      const pr =
        typeof body?.deviceCode === 'string' ? state.pairings.get(body.deviceCode) : undefined;
      if (!pr || now() - pr.createdAt > 600_000 || pr.status === 'consumed') {
        return json(400, { error: 'expired_token' });
      }
      if (opts.autoApproveS && now() - pr.createdAt >= opts.autoApproveS * 1000)
        pr.status = 'approved';
      if (pr.status === 'pending') {
        const tooSoon = pr.lastPoll && now() - pr.lastPoll < intervalS * 1000 - 500;
        pr.lastPoll = now();
        return json(400, { error: tooSoon ? 'slow_down' : 'authorization_pending' });
      }
      pr.status = 'consumed';
      const cred = credential();
      const id = randomUUID();
      state.credentials.set(cred, { id, expiresAt: null, superseded: false });
      log('pairing approved: credential issued');
      return json(200, {
        credential: cred,
        credentialId: id,
        scopes: ['meters:write'],
        vesselLabel: 'Mock Vessel',
        provider: 'signalk',
      });
    }

    const isStatus = p === '/v1/integrations/status' && method === 'GET';
    const isRotate = p === '/v1/integrations/credential/rotate' && method === 'POST';
    const isReadings = p === '/v1/integrations/signalk/readings' && method === 'POST';
    if (!isStatus && !isRotate && !isReadings) return json(404, { message: 'Not found' });

    const a = auth(headers);
    if (a.deny) return a.deny;

    if (isStatus) {
      const v = Number(headers['x-vesseltwin-contract']);
      return json(200, {
        provider: 'signalk',
        minContract: CONTRACT.min,
        latestContract: CONTRACT.latest,
        pluginUpdateRecommended: !(v >= CONTRACT.latest),
        serverTime: new Date(now()).toISOString(),
        summary: null,
      });
    }

    if (isRotate) {
      if (a.rec.superseded) {
        return err(409, 'integration_credential_superseded', 'Credential was already replaced.');
      }
      const next = credential();
      const id = randomUUID();
      a.rec.superseded = true;
      a.rec.expiresAt = now() + 600_000;
      state.credentials.set(next, { id, expiresAt: null, superseded: false });
      return json(200, {
        credential: next,
        credentialId: id,
        provider: 'signalk',
        scopes: ['meters:write'],
        previousExpiresAt: new Date(a.rec.expiresAt).toISOString(),
      });
    }

    // readings
    const c = contractCheck(headers);
    if (c) return c;
    const f = injected(q);
    if (f === '401') return auth({}).deny;
    if (f === '403') return err(403, 'integration_paused_plan', 'Not available on this plan.');
    if (f === '503') {
      return err(
        503,
        'integration_feature_unavailable',
        'Unavailable.',
        {},
        { 'retry-after': String(state.retryAfterS) },
      );
    }
    if (f === '426') {
      return err(426, 'integration_contract_unsupported', 'Update required.', {
        minContract: 2,
        latestContract: 2,
      });
    }
    if (f === '429') {
      return err(
        429,
        'integration_rate_limited',
        'Too many requests.',
        {},
        { 'retry-after': String(state.retryAfterS) },
      );
    }
    if (f === '500') return json(500, { message: 'Internal server error' });
    if (f === 'slow') await new Promise((r) => setTimeout(r, state.slowMs));

    const list = body?.readings;
    const valid =
      body &&
      Object.keys(body).length === 1 &&
      Array.isArray(list) &&
      list.length >= 1 &&
      list.length <= 500 &&
      list.every(
        (r) =>
          r &&
          Object.keys(r).sort().join() === 'clientReadingId,path,recordedAt,value' &&
          UUID_RE.test(r.clientReadingId) &&
          PATH_RE.test(r.path) &&
          typeof r.value === 'number' &&
          Number.isFinite(r.value) &&
          typeof r.recordedAt === 'string' &&
          !Number.isNaN(Date.parse(r.recordedAt)),
      );
    if (!valid) return json(400, { message: 'Validation failed', errors: [] });

    const results = [];
    const tally = { accepted: 0, duplicate: 0 };
    const lines = [];
    for (const r of list) {
      if (f === 'duplicate' || state.seen.has(r.clientReadingId)) {
        results.push({ clientReadingId: r.clientReadingId, status: 'duplicate' });
        tally.duplicate += 1;
        continue;
      }
      state.seen.add(r.clientReadingId);
      state.readings.push({ ...r, receivedAt: new Date(now()).toISOString() });
      results.push({ clientReadingId: r.clientReadingId, status: 'accepted' });
      tally.accepted += 1;
      lines.push(`${r.path}=${String(r.value)}`);
    }
    state.batches += 1;
    log(
      `batch #${String(state.batches)} n=${String(list.length)} accepted=${String(tally.accepted)} duplicate=${String(tally.duplicate)} ${lines.slice(0, 4).join(' ')}`,
    );
    return json(200, { serverTime: new Date(now()).toISOString(), results });
  }

  return { handle, state, approve };
}
