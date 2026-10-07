// Pure view logic for the pairing page: no DOM, no network, no timers.
// This file is compiled for the browser (web/tsconfig.json) and imported by tests under Node.
// It must not import from ../src (the page ships separately from the plugin code).

export const PLUGIN_BASE = '/plugins/signalk-vesseltwin';
export const ADMIN_LOGIN_PATH = '/admin/#/login';
export const PLUGIN_CONFIG_PATH = '/admin/#/serverConfiguration/plugins/signalk-vesseltwin';
export const DEFAULT_API_ORIGIN = 'https://api.vesseltwin.io';
export const UPLOAD_NOTICE = 'Data upload is not available in this version.';

/** Mirrors `PluginState` in src/plugin.ts (a contract test keeps the two lists in sync). */
export const KNOWN_STATES = [
  'not_paired',
  'pairing',
  'pairing_failed',
  'checking',
  'connected',
  'paused',
  'offline',
  'update_required',
  'reauth_required',
  'config_error',
] as const;
export type KnownState = (typeof KNOWN_STATES)[number];
export type PageState = KnownState | 'unknown';

export type ActionId = 'pair' | 'cancel' | 'unpair';
export interface Action {
  id: ActionId;
  label: string;
}
export interface LinkInfo {
  href: string;
  label: string;
  /** Same-origin admin link (opens in this tab) versus external (new tab). */
  external: boolean;
}

/** What `parseStatus` makes of a /status body. Only fields the page uses. */
export interface StatusModel {
  state: PageState;
  paired: boolean;
  vesselLabel: string | null;
  /** Shown only when the plugin talks to a non-default API (a test-API hint). */
  apiHint: string | null;
  userCode: string | null;
  /** Validated: https, or http on a loopback host. Null when absent or unsafe. */
  verificationUrl: string | null;
  /** Selects buttons only; never displayed. */
  failureReason: string | null;
  expiresInSeconds: number | null;
  updateRecommended: boolean;
  clockSkewWarning: boolean;
  message: string;
}

// Control characters, invisible format characters (bidi overrides, zero-width) and line/paragraph
// separators.
const UNSAFE_PATTERN = '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\p{Cf}]';
const UNSAFE_CHARS = new RegExp(UNSAFE_PATTERN, 'u');
const UNSAFE_CHARS_G = new RegExp(UNSAFE_PATTERN, 'gu');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Server text shown to the user: strip unsafe characters, collapse space, cap the length. */
export function cleanText(v: unknown, max = 400): string {
  if (typeof v !== 'string') return '';
  return v.replace(UNSAFE_CHARS_G, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A short printable single-line string, or null (used for the 503 `error` text). */
export function shortPrintable(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.length > max || UNSAFE_CHARS.test(t)) return null;
  return t;
}

/** Accept a verification link only if it is https, or http on a loopback host. */
export function safeVerificationUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 300) return null;
  if (UNSAFE_CHARS.test(v) || /\s/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '') return null;
  if (u.protocol === 'https:' && u.hostname !== '') return u.href;
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u.href;
  return null;
}

function safeCode(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9-]{4,32}$/.test(v) ? v : null;
}

function safeOrigin(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200 || UNSAFE_CHARS.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

const MAX_COUNTDOWN_SECONDS = 24 * 60 * 60;

function seconds(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(MAX_COUNTDOWN_SECONDS, Math.max(0, Math.round(v)));
}

function isKnown(v: unknown): v is KnownState {
  return typeof v === 'string' && (KNOWN_STATES as readonly string[]).includes(v);
}

/** Defensive parse of the untyped /status JSON. Never throws. */
export function parseStatus(json: unknown): StatusModel {
  const o = isRecord(json) ? json : {};
  const pairing = isRecord(o.pairing) ? o.pairing : {};
  const origin = safeOrigin(o.apiOrigin);
  const label = cleanText(o.vesselLabel, 80);
  const state: PageState = isKnown(o.state) ? o.state : 'unknown';
  return {
    state,
    paired: o.paired === true,
    vesselLabel: label === '' ? null : label,
    apiHint: origin !== null && origin !== DEFAULT_API_ORIGIN ? origin : null,
    userCode: safeCode(pairing.userCode),
    verificationUrl: safeVerificationUrl(pairing.verificationUrl),
    failureReason: typeof pairing.reason === 'string' ? cleanText(pairing.reason, 40) : null,
    expiresInSeconds: seconds(pairing.expiresInSeconds),
    updateRecommended: o.updateRecommended === true,
    clockSkewWarning: o.clockSkewWarning === true,
    message: state === 'unknown' ? '' : cleanText(o.message),
  };
}

/** The page shows the upload notice permanently; drop an exact trailing copy of it from a message. */
export function stripUploadNotice(message: string): string {
  return message.endsWith(UPLOAD_NOTICE)
    ? message.slice(0, message.length - UPLOAD_NOTICE.length).trim()
    : message;
}

/** Seconds left from the server's `expiresInSeconds` minus local elapsed time; never negative or NaN. */
export function remainingSeconds(
  expiresInSeconds: number | null,
  elapsedMs: number,
): number | null {
  const start = seconds(expiresInSeconds);
  if (start === null) return null;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return Math.max(0, Math.ceil(start - elapsed / 1000));
}

/** `m:ss`, or `h:mm:ss` from an hour up. Garbage in gives `0:00`. */
export function formatCountdown(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** The buttons for a state. */
export function actionsFor(m: StatusModel): Action[] {
  switch (m.state) {
    case 'not_paired':
      return [{ id: 'pair', label: 'Pair' }];
    case 'pairing':
      return [{ id: 'cancel', label: 'Cancel' }];
    case 'checking':
      return m.paired ? [{ id: 'unpair', label: 'Unpair' }] : [];
    case 'pairing_failed':
      return [{ id: 'pair', label: 'Try again' }];
    case 'connected':
    case 'paused':
    case 'offline':
    case 'update_required':
      return [{ id: 'unpair', label: 'Unpair' }];
    case 'reauth_required':
      return [
        { id: 'pair', label: 'Pair again' },
        { id: 'unpair', label: 'Unpair' },
      ];
    case 'config_error':
    case 'unknown':
      return [];
  }
}

export interface Screen {
  title: string;
  message: string;
  /** Extra remedy line (update_required). */
  hint: string | null;
  code: string | null;
  link: LinkInfo | null;
  countdown: string | null;
  actions: Action[];
  apiHint: string | null;
}

const TITLES: Record<PageState, string> = {
  not_paired: 'Not paired',
  pairing: 'Waiting for your approval',
  pairing_failed: 'Pairing did not finish',
  checking: 'Checking the connection',
  connected: 'Connected',
  paused: 'Connection paused',
  offline: 'Cannot reach VesselTwin',
  update_required: 'Plugin update needed',
  reauth_required: 'Pair again',
  config_error: 'Settings problem',
  unknown: 'Status unavailable',
};

export const EXPIRED_COPY = 'The code expired. Waiting for the plugin.';
export const GENERIC_STATUS_COPY = 'The plugin sent a status this page does not understand.';

/** Everything the DOM layer needs for one status, given the seconds left on a pairing code. */
export function describeStatus(m: StatusModel, remaining: number | null): Screen {
  const message =
    m.state === 'unknown' ? GENERIC_STATUS_COPY : stripUploadNotice(m.message) || TITLES[m.state];
  let countdown: string | null = null;
  if (m.state === 'pairing' && remaining !== null) {
    countdown = remaining > 0 ? formatCountdown(remaining) : EXPIRED_COPY;
  }
  const showPairing = m.state === 'pairing';
  return {
    title: TITLES[m.state],
    message,
    hint: m.state === 'update_required' ? 'Update it from the SignalK Appstore.' : null,
    code: showPairing ? m.userCode : null,
    link:
      showPairing && m.verificationUrl
        ? { href: m.verificationUrl, label: 'Open VesselTwin to approve', external: true }
        : m.state === 'config_error'
          ? { href: PLUGIN_CONFIG_PATH, label: 'Open the plugin settings', external: false }
          : null,
    countdown,
    actions: actionsFor(m),
    apiHint: m.apiHint,
  };
}

export type ProblemKind = 'signin' | 'forbidden' | 'unavailable' | 'unreachable';
export interface Problem {
  kind: ProblemKind;
  message: string;
  link: LinkInfo | null;
}

export const UNREACHABLE_COPY = 'Cannot reach the plugin.';
export const UNAVAILABLE_COPY = 'The plugin is not available right now.';

/**
 * Map a failed or unusable HTTP answer to page copy. `status` is null for network errors and
 * non-JSON bodies. `body` is the parsed JSON when there was one.
 */
export function describeProblem(status: number | null, body: unknown): Problem {
  if (status === 401) {
    return {
      kind: 'signin',
      message: 'Sign in to SignalK as an administrator to use this page.',
      link: { href: ADMIN_LOGIN_PATH, label: 'Open the SignalK sign-in', external: false },
    };
  }
  if (status === 403) return { kind: 'forbidden', message: 'Request not allowed.', link: null };
  if (status === 503) {
    const text = isRecord(body) ? shortPrintable(body.error) : null;
    return { kind: 'unavailable', message: text ?? UNAVAILABLE_COPY, link: null };
  }
  return { kind: 'unreachable', message: UNREACHABLE_COPY, link: null };
}
