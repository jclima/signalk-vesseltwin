// Mock VesselTwin integrations API for local testing of the plugin. Zero dependencies.
// Test use only: it holds everything in memory and trusts every caller.
//
// Scope: pairing (start, token), device status, credential rotation, and the contract-2 readings
// ingest route (a minimal model: envelope and per-item rules, idempotency, no storage of values).
//
// Response shapes mirror docs/api.md.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PROVIDER = 'signalk';
const SCOPES = ['meters:write', 'vessel-info:suggest'];
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // codes module: USER_CODE_ALPHABET
const PAIRING_TTL_S = 600; // codes module: PAIRING_TTL_MS = 10 min
const ROTATION_GRACE_MS = 10 * 60 * 1000; // types: INTEGRATION_ROTATION_GRACE_MS
const RETRY_AFTER_UNAVAILABLE_S = 3600; // types: INTEGRATION_RETRY_AFTER_S
const MOCK_LATEST_CONTRACT = 2; // real server window: min 1, latest 2
const MAX_BODY_BYTES = 64 * 1024;
const READINGS_ROUTE = 'signalk/readings';
export const READINGS_MAX_BODY_BYTES = 512 * 1024;
const READINGS_MIN_CONTRACT = 2;
const MAX_BATCH = 500;
const FUTURE_SKEW_MS = 5 * 60_000;
const TOO_OLD_MS = 8 * 24 * 3600_000; // the platform's window; the plugin never sends older than 7 days
// Permitted paths, mirroring src/mapping.ts (kept as a small copy: this file is plain ESM).
const ID = '([A-Za-z0-9_-]{1,40})';
const TANK = '(fuel|freshWater|wasteWater|blackWater|lubrication|liveWell|baitWell|gas|ballast)';
const PATH_RES = [
  `^propulsion\\.${ID}\\.runTime$`,
  `^electrical\\.generators\\.${ID}\\.runTime$`,
  `^electrical\\.batteries\\.${ID}\\.voltage$`,
  `^electrical\\.batteries\\.${ID}\\.capacity\\.stateOfCharge$`,
  `^tanks\\.${TANK}\\.${ID}\\.currentLevel$`,
  `^tanks\\.${TANK}\\.${ID}\\.currentVolume$`,
].map((r) => new RegExp(r));
const isPermittedPath = (p) =>
  typeof p === 'string' && p.length <= 200 && PATH_RES.some((r) => r.test(p));
const CREDENTIAL_RE = /^vti_[A-Za-z0-9_-]{43}$/; // codes module: CREDENTIAL_PATTERN

const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const ROUTES = ['pairing/start', 'pairing/token', 'status', 'credential/rotate', READINGS_ROUTE];
const DEFAULT_FAULT_CODE = {
  401: 'integration_unauthorized',
  403: 'integration_paused_plan',
  426: 'integration_contract_unsupported',
  429: 'integration_rate_limited',
  503: 'integration_feature_unavailable',
};
const DEFAULT_FAULT_MESSAGE = {
  401: 'Authentication required',
  403: 'This integration is paused for this account.',
  426: 'This client version is not supported.',
  413: 'Payload too large',
  429: 'Too many requests.', // shape assumed; the rate limiter was not mirrored
  503: 'This integration is not available right now.',
};

/** Mirrors `shortText(max)` in the types package (trim, NFC, no control or format chars). */
function shortText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').trim();
  if (t.length < 1 || t.length > max || /[\p{Cc}\p{Cf}]/u.test(t)) return null;
  return t;
}

/** Returns a list of {path,message} issues for the pairing start body (strict). */
function validateStart(b) {
  const issues = [];
  const bad = (path, message = 'Invalid') => issues.push({ path, message });
  if (typeof b !== 'object' || b === null || Array.isArray(b))
    return [{ path: '', message: 'Invalid' }];
  const known = [
    'provider',
    'clientName',
    'clientVersion',
    'contractVersion',
    'deviceLabel',
    'requestedScopes',
    'providerHints',
  ];
  for (const k of Object.keys(b)) if (!known.includes(k)) bad(k, 'Unrecognized key');
  if (b.provider !== PROVIDER) bad('provider');
  if (shortText(b.clientName, 80) === null) bad('clientName');
  if (shortText(b.clientVersion, 40) === null) bad('clientVersion');
  if (shortText(b.deviceLabel, 120) === null) bad('deviceLabel');
  if (!Number.isInteger(b.contractVersion) || b.contractVersion < 1 || b.contractVersion > 1000) {
    bad('contractVersion');
  }
  if (
    !Array.isArray(b.requestedScopes) ||
    b.requestedScopes.length < 1 ||
    b.requestedScopes.length > SCOPES.length ||
    b.requestedScopes.some((s) => !SCOPES.includes(s))
  ) {
    bad('requestedScopes');
  }
  if (b.providerHints !== undefined) {
    const h = b.providerHints;
    if (typeof h !== 'object' || h === null || Array.isArray(h)) bad('providerHints');
    else {
      // docs/api.md: SignalK accepts only { signalkSelfUuid: string (1-100 chars) }
      for (const k of Object.keys(h))
        if (k !== 'signalkSelfUuid') bad('providerHints', 'Unrecognized key');
      if (
        h.signalkSelfUuid !== undefined &&
        (typeof h.signalkSelfUuid !== 'string' ||
          h.signalkSelfUuid.length < 1 ||
          h.signalkSelfUuid.length > 100)
      ) {
        bad('providerHints.signalkSelfUuid');
      }
    }
  }
  return issues;
}

const validationFailed = (errors) => ({
  status: 400,
  // validation failure: { message, errors: [{ path, message }] }
  body: { message: 'Validation failed', errors },
});

/**
 * @param {object} [o]
 * @param {number} [o.pollIntervalS] pairing poll spacing, seconds (platform: 5)
 * @param {number} [o.autoApproveAfterPolls] approve a pairing automatically on its Nth poll (0 = manual)
 * @param {string} [o.verificationUrl] shown to the user; the platform uses its public connect page
 * @param {() => number} [o.now]
 */
export function createMock(o = {}) {
  const pollIntervalS = o.pollIntervalS ?? 5;
  const autoApproveAfterPolls = o.autoApproveAfterPolls ?? 0;
  const verificationUrl = o.verificationUrl ?? 'http://localhost:3001/connect';
  const now = o.now ?? Date.now;

  /** deviceCodeHash -> pairing */
  const pairings = new Map();
  /** credentialHash -> credential row */
  const credentials = new Map();
  /** route -> fault[] */
  let faults = new Map();
  /** @type {object[]} */
  let log = [];
  /** Status `summary` object ({channels, awaitingSetup, held}) or null; set via /__mock/summary. */
  let summary = null;
  /** credentialId -> Map(clientReadingId -> fingerprint), for idempotency. */
  const seenReadings = new Map();

  function issueCredential(provider, scopes) {
    const secret = `vti_${randomBytes(32).toString('base64url')}`; // codes module: generateCredential
    const row = {
      id: randomUUID(),
      provider,
      scopes,
      createdAt: now(),
      expiresAt: null,
      revoked: false,
    };
    credentials.set(sha256(secret), row);
    return { secret, row };
  }

  function takeFault(route) {
    for (const key of [route, '*']) {
      const list = faults.get(key);
      const f = list?.[0];
      if (!f) continue;
      if (f.once) list.shift();
      return f;
    }
    return null;
  }

  function faultResponse(f) {
    const body = { message: DEFAULT_FAULT_MESSAGE[f.status] ?? 'Injected fault.' };
    // 413 and 500 are framework-style bodies without a platform code unless one is injected.
    const code =
      f.code ??
      DEFAULT_FAULT_CODE[f.status] ??
      (f.status < 500 && f.status !== 413 ? 'integration_error' : undefined);
    if (code !== undefined) body.code = code;
    const headers = {};
    let retryAfter = f.retryAfter;
    if (f.status === 503 && retryAfter === undefined) retryAfter = RETRY_AFTER_UNAVAILABLE_S;
    if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter);
    // the 503 body also carries retryAfter (seconds)
    if (f.status === 503 && retryAfter !== undefined) body.retryAfter = Number(retryAfter);
    // 426 and 400 carry the contract window
    if (f.status === 426 || f.status === 400 || f.minContract !== undefined) {
      body.minContract = f.minContract ?? 1;
      body.latestContract = f.latestContract ?? Math.max(MOCK_LATEST_CONTRACT, f.minContract ?? 1);
    }
    return { status: f.status, body, headers };
  }

  /** Contract header: an integer 1..9999, else null. */
  function parseContract(v) {
    if (typeof v !== 'string' || !/^\d{1,4}$/.test(v.trim())) return null;
    const n = Number(v.trim());
    return n >= 1 ? n : null;
  }

  /** Status with an injected 200: lets a tester see the plugin react to a raised minimum contract. */
  function statusWithWindow(f, contract) {
    const min = f.minContract ?? 1;
    const latest = f.latestContract ?? Math.max(MOCK_LATEST_CONTRACT, min);
    return {
      status: 200,
      headers: {},
      // status body: provider, minContract, latestContract, pluginUpdateRecommended, serverTime, summary
      body: {
        provider: PROVIDER,
        minContract: min,
        latestContract: latest,
        pluginUpdateRecommended: contract === null || contract < latest,
        serverTime: new Date(now()).toISOString(),
        summary,
      },
    };
  }

  /** Credential checks: bearer format, known, live. */
  function authenticate(headers) {
    const m = /^Bearer ([^\s]+)$/.exec((headers.authorization ?? '').trim());
    const secret = m && CREDENTIAL_RE.test(m[1]) ? m[1] : null;
    const row = secret ? credentials.get(sha256(secret)) : undefined;
    if (!row || row.revoked || (row.expiresAt !== null && row.expiresAt <= now())) return null;
    return row;
  }

  const unauthorized = () => ({
    status: 401,
    headers: {},
    body: { code: 'integration_unauthorized', message: 'Authentication required' },
  });

  const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' };

  function pairingStart(body) {
    const issues = validateStart(body);
    if (issues.length) return validationFailed(issues);
    if (body.contractVersion > MOCK_LATEST_CONTRACT) {
      // integration_contract_unsupported above the latest contract
      return {
        status: 400,
        body: {
          code: 'integration_contract_unsupported',
          message: 'This client version is not supported.',
        },
      };
    }
    let userCode = '';
    for (let i = 0; i < 8; i += 1)
      userCode += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    const deviceCode = randomBytes(32).toString('base64url'); // codes module: generateDeviceCode
    pairings.set(sha256(deviceCode), {
      userCode,
      scopes: [...new Set(body.requestedScopes)],
      status: 'pending',
      expiresAt: now() + PAIRING_TTL_S * 1000,
      lastPolledAt: null,
      polls: 0,
    });
    return {
      status: 200,
      // deviceCode, userCode (ABCD-EFGH), verificationUrl, interval, expiresIn
      body: {
        deviceCode,
        userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
        verificationUrl,
        interval: pollIntervalS,
        expiresIn: PAIRING_TTL_S,
      },
      headers: noStore,
    };
  }

  // poll errors are HTTP 400 with { error }
  const pollError = (error) => ({ status: 400, body: { error }, headers: noStore });

  function pairingToken(body) {
    const isObj = typeof body === 'object' && body !== null && !Array.isArray(body);
    const trimmed = isObj && typeof body.deviceCode === 'string' ? body.deviceCode.trim() : '';
    // body is exactly { deviceCode: trimmed string, 16..128 chars }
    if (!isObj || Object.keys(body).length !== 1 || trimmed.length < 16 || trimmed.length > 128) {
      return validationFailed([{ path: 'deviceCode', message: 'Invalid' }]);
    }
    const p = pairings.get(sha256(trimmed));
    // unknown, expired and consumed all read as expired_token
    if (!p) return pollError('expired_token');
    if (
      p.status === 'consumed' ||
      (['pending', 'approved'].includes(p.status) && p.expiresAt <= now())
    ) {
      return pollError('expired_token');
    }
    if (p.status === 'denied') return pollError('access_denied');
    // only one poll per interval is accepted, else slow_down
    if (p.lastPolledAt !== null && now() - p.lastPolledAt < pollIntervalS * 1000) {
      return pollError('slow_down');
    }
    p.lastPolledAt = now();
    p.polls += 1;
    if (p.status === 'pending' && autoApproveAfterPolls > 0 && p.polls >= autoApproveAfterPolls) {
      p.status = 'approved';
    }
    if (p.status === 'pending') return pollError('authorization_pending');
    p.status = 'consumed';
    const { secret, row } = issueCredential(PROVIDER, p.scopes);
    return {
      status: 200,
      // credential (shown once), credentialId (uuid), scopes, vesselLabel (string | null), provider
      body: {
        credential: secret,
        credentialId: row.id,
        scopes: row.scopes,
        vesselLabel: 'Mock Boat',
        provider: PROVIDER,
      },
      headers: noStore,
    };
  }

  function status(headers, fault) {
    const contract = parseContract(headers['x-vesseltwin-contract']);
    if (fault && fault.status === 200) return statusWithWindow(fault, contract);
    if (!authenticate(headers)) return unauthorized();
    return {
      status: 200,
      headers: {},
      // Contract window is [1, 2], like the real server: a contract-1 plugin is told an update exists.
      body: {
        provider: PROVIDER,
        minContract: 1,
        latestContract: MOCK_LATEST_CONTRACT,
        pluginUpdateRecommended: contract === null || contract < MOCK_LATEST_CONTRACT,
        serverTime: new Date(now()).toISOString(),
        summary, // the provider's statusSummary is optional; null when absent
      },
    };
  }

  /** Envelope check for the readings body (strict, like the vendored request schema). */
  function validateReadings(b) {
    const errors = [];
    const bad = (path, message = 'Invalid') => errors.push({ path, message });
    const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
    if (!isObj(b)) return [{ path: '', message: 'Invalid' }];
    for (const k of Object.keys(b)) if (k !== 'readings') bad(k, 'Unrecognized key');
    if (!Array.isArray(b.readings) || b.readings.length < 1 || b.readings.length > MAX_BATCH) {
      bad('readings');
      return errors;
    }
    const keys = ['clientReadingId', 'path', 'value', 'recordedAt'];
    b.readings.forEach((r, i) => {
      const at = (k) => `readings.${String(i)}.${k}`;
      if (!isObj(r)) return bad(`readings.${String(i)}`);
      for (const k of Object.keys(r)) if (!keys.includes(k)) bad(at(k), 'Unrecognized key');
      const str = (k, max) =>
        typeof r[k] !== 'string' || r[k].length < 1 || r[k].length > max ? bad(at(k)) : undefined;
      str('clientReadingId', 64);
      str('path', 200);
      str('recordedAt', 40);
      if (r.value !== null && !(typeof r.value === 'number' && Number.isFinite(r.value))) {
        bad(at('value'));
      }
    });
    return errors;
  }

  /** One item -> result, or null for "valid so far". Pure apart from the idempotency map. */
  function judgeReading(r, seen) {
    const reject = (reason) => ({ clientReadingId: r.clientReadingId, status: 'rejected', reason });
    if (!isPermittedPath(r.path)) return reject('invalid_path');
    if (r.value === null) return reject('invalid_value');
    const t = Date.parse(r.recordedAt);
    if (Number.isNaN(t)) return reject('invalid_time');
    if (t > now() + FUTURE_SKEW_MS) return reject('future');
    if (t < now() - TOO_OLD_MS) return reject('too_old');
    const fp = `${r.path}|${String(r.value)}|${String(t)}`;
    const prior = seen.get(r.clientReadingId);
    if (prior === undefined) {
      seen.set(r.clientReadingId, fp);
      return { clientReadingId: r.clientReadingId, status: 'accepted' };
    }
    // Same id, same body: idempotent replay. Same id, different body: id reuse.
    return prior === fp
      ? { clientReadingId: r.clientReadingId, status: 'duplicate' }
      : reject('invalid_id');
  }

  function readings(headers, body) {
    const cred = authenticate(headers);
    if (!cred) return unauthorized();
    const contract = parseContract(headers['x-vesseltwin-contract']);
    if (contract === null || contract < READINGS_MIN_CONTRACT) {
      return {
        status: 426,
        headers: {},
        body: {
          code: 'integration_contract_unsupported',
          message: 'This client version is not supported.',
          minContract: READINGS_MIN_CONTRACT,
          latestContract: MOCK_LATEST_CONTRACT,
        },
      };
    }
    if (!cred.scopes.includes('meters:write')) {
      return {
        status: 403,
        headers: {},
        body: { code: 'integration_scope', message: 'This credential cannot upload readings.' },
      };
    }
    const errors = validateReadings(body);
    if (errors.length) return validationFailed(errors);
    let seen = seenReadings.get(cred.id);
    if (!seen) seenReadings.set(cred.id, (seen = new Map()));
    return {
      status: 200,
      headers: {},
      body: {
        serverTime: new Date(now()).toISOString(),
        results: body.readings.map((r) => judgeReading(r, seen)),
      },
    };
  }

  function rotate(headers) {
    const cred = authenticate(headers);
    if (!cred) return unauthorized();

    if (cred.expiresAt !== null) {
      return {
        status: 409,
        headers: {},
        body: {
          code: 'integration_credential_superseded',
          message: 'This credential was already replaced. Pair the device again.',
        },
      };
    }
    cred.expiresAt = now() + ROTATION_GRACE_MS;
    const { secret, row } = issueCredential(cred.provider, cred.scopes);
    return {
      status: 200,
      // credential, credentialId, provider, scopes, previousExpiresAt
      body: {
        credential: secret,
        credentialId: row.id,
        provider: row.provider,
        scopes: row.scopes,
        previousExpiresAt: new Date(cred.expiresAt).toISOString(),
      },
      headers: noStore,
    };
  }

  /** Debug surface. Never part of the platform. */
  function debug(method, path, body) {
    if (method === 'GET' && path === '/__mock/log') return { status: 200, body: { entries: log } };
    if (method === 'POST' && path === '/__mock/reset') {
      pairings.clear();
      credentials.clear();
      seenReadings.clear();
      summary = null;
      faults = new Map();
      log = [];
      return { status: 200, body: { ok: true } };
    }
    if (method === 'POST' && path === '/__mock/approve') {
      const wanted =
        typeof body?.userCode === 'string'
          ? body.userCode.toUpperCase().replace(/[\s-]/g, '')
          : null;
      const pending = [...pairings.values()].filter(
        (p) => p.status === 'pending' && p.expiresAt > now(),
      );
      const target = wanted ? pending.find((p) => p.userCode === wanted) : pending.at(-1);
      if (!target) return { status: 404, body: { error: 'no_matching_pending_pairing' } };
      target.status = body?.deny === true ? 'denied' : 'approved';
      return { status: 200, body: { status: target.status } };
    }
    if (method === 'POST' && path === '/__mock/summary') {
      // { channels, awaitingSetup, held } (non-negative integers), or { "summary": null } to clear
      const b = body?.summary === null ? null : body;
      const ok = (v) => Number.isInteger(v) && v >= 0;
      if (b !== null && !(ok(b?.channels) && ok(b?.awaitingSetup) && ok(b?.held))) {
        return {
          status: 400,
          body: { error: 'need integer channels, awaitingSetup, held >= 0, or {"summary":null}' },
        };
      }
      summary =
        b === null ? null : { channels: b.channels, awaitingSetup: b.awaitingSetup, held: b.held };
      return { status: 200, body: { ok: true, summary } };
    }
    if (method === 'POST' && path === '/__mock/fault') {
      const route = body?.route;
      if (route === 'clear') {
        faults = new Map();
        return { status: 200, body: { ok: true } };
      }
      if (![...ROUTES, '*'].includes(route) || !Number.isInteger(body?.status)) {
        return {
          status: 400,
          body: {
            error:
              'need route (pairing/start, pairing/token, status, credential/rotate, signalk/readings, *, or "clear") and integer status',
          },
        };
      }
      const fault = {};
      for (const k of ['status', 'code', 'retryAfter', 'minContract', 'latestContract', 'once']) {
        if (body[k] !== undefined) fault[k] = body[k];
      }
      faults.set(route, [...(body.append === true ? (faults.get(route) ?? []) : []), fault]);
      return { status: 200, body: { ok: true, route, fault } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  /**
   * @param {{method:string,url:string,headers:Record<string,string>,body:unknown}} req
   */
  function handle(req) {
    const path = req.url.split('?')[0] ?? '/';
    if (path.startsWith('/__mock/')) return debug(req.method, path, req.body);

    const prefix = '/v1/integrations/';
    const route = path.startsWith(prefix) ? path.slice(prefix.length) : null;
    const known =
      (route === 'pairing/start' && req.method === 'POST') ||
      (route === 'pairing/token' && req.method === 'POST') ||
      (route === 'status' && req.method === 'GET') ||
      (route === 'credential/rotate' && req.method === 'POST') ||
      (route === READINGS_ROUTE && req.method === 'POST');

    let out;
    let faulted = false;
    if (!known) {
      out = { status: 404, headers: {}, body: { message: 'Not Found', statusCode: 404 } };
    } else {
      const fault = takeFault(route);
      faulted = fault !== null;
      if (fault && !(route === 'status' && fault.status === 200)) out = faultResponse(fault);
      else if (route === 'pairing/start') out = pairingStart(req.body);
      else if (route === 'pairing/token') out = pairingToken(req.body);
      else if (route === 'status') out = status(req.headers, fault);
      else if (route === READINGS_ROUTE) out = readings(req.headers, req.body);
      else out = rotate(req.headers);
    }
    // Log metadata only. Bodies, Authorization values and codes are never recorded.
    log.push({
      ts: new Date(now()).toISOString(),
      method: req.method,
      path,
      status: out.status,
      auth: Boolean(req.headers.authorization),
      contractHeader: req.headers['x-vesseltwin-contract'] ?? null,
      userAgent: Boolean(req.headers['user-agent']),
      fault: faulted,
    });
    return out;
  }

  return { handle };
}

/** Starts the mock on a node:http server. Resolves once listening. */
export async function startMock({ host = '0.0.0.0', port = 3001, ...options } = {}) {
  const mock = createMock(options);
  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    const limit =
      (req.url ?? '').split('?')[0] === `/v1/integrations/${READINGS_ROUTE}`
        ? READINGS_MAX_BODY_BYTES
        : MAX_BODY_BYTES;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      const send = (out) => {
        res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
        res.end(JSON.stringify(out.body));
      };
      if (tooBig) return send({ status: 413, body: { message: 'Payload too large' } });
      let body;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send({ status: 400, body: { message: 'Invalid JSON' } });
        }
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      send(mock.handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
