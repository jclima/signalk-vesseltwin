import type { Category } from './mapping';

export interface PluginOptions {
  /** Validated API base URL; null when the configured value is invalid (see `configError`). */
  apiBaseUrl: string | null;
  /** Neutral, user-facing copy when a SET setting is invalid. No network calls while this is set. */
  configError: string | null;
  categories: Record<Category, boolean>;
  samplePeriodSeconds: number;
  queueMaxReadings: number;
}

export const DEFAULT_API_BASE_URL = 'https://api.vesseltwin.io';

export const CONFIG_ERROR_API_URL =
  'The VesselTwin API URL in the plugin settings is not valid. Fix it and restart the plugin.';

/** Origin (scheme + host + port) of an API base URL; null if it does not parse. */
export function apiOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const configSchema = {
  type: 'object',
  properties: {
    apiBaseUrl: {
      type: 'string',
      title: 'VesselTwin API URL',
      description:
        'Leave the default unless you are testing against a local or test VesselTwin API.',
      default: DEFAULT_API_BASE_URL,
    },
    sendEngineHours: { type: 'boolean', title: 'Send engine and generator hours', default: true },
    sendBatteries: {
      type: 'boolean',
      title: 'Send battery voltage and state of charge',
      default: true,
    },
    sendTanks: { type: 'boolean', title: 'Send tank levels', default: true },
    sendVesselInfo: {
      type: 'boolean',
      title: 'Suggest vessel details (name, dimensions)',
      description: 'Suggestions only; you approve them in VesselTwin. Not active yet.',
      default: false,
    },
    samplePeriodSeconds: {
      type: 'number',
      title: 'Sample period (seconds)',
      default: 300,
      minimum: 10,
    },
    queueMaxReadings: {
      type: 'number',
      title: 'Offline queue cap (readings)',
      default: 50000,
      minimum: 1000,
      maximum: 50000,
    },
  },
} as const;

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

function num(v: unknown, d: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
}

/**
 * Unset (undefined or null) means the production default. A SET value must be https (or http
 * on localhost, 127.0.0.1, [::1]) with no credentials, query or hash; anything else is a config
 * error and never silently falls back to production.
 */
function parseApiBaseUrl(v: unknown): { url: string | null; error: string | null } {
  if (v === undefined || v === null) {
    return { url: DEFAULT_API_BASE_URL, error: null };
  }
  const bad = { url: null, error: CONFIG_ERROR_API_URL };
  if (typeof v !== 'string') return bad;
  try {
    const u = new URL(v.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    const clean = !u.username && !u.password && !u.search && !u.hash;
    if (clean && (u.protocol === 'https:' || (u.protocol === 'http:' && local))) {
      return { url: u.toString().replace(/\/$/, ''), error: null };
    }
  } catch {
    // fall through
  }
  return bad;
}

/** Defensive: plugin settings arrive as untyped JSON. Unknown/invalid numbers and booleans fall back to defaults; an invalid API URL is an error. */
export function parseOptions(raw: unknown): PluginOptions {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { url, error } = parseApiBaseUrl(o.apiBaseUrl);
  return {
    apiBaseUrl: url,
    configError: error,
    categories: {
      engineHours: bool(o.sendEngineHours, true),
      batteries: bool(o.sendBatteries, true),
      tanks: bool(o.sendTanks, true),
      vesselInfo: bool(o.sendVesselInfo, false),
    },
    samplePeriodSeconds: num(o.samplePeriodSeconds, 300, 10, 86_400),
    queueMaxReadings: num(o.queueMaxReadings, 50_000, 1_000, 50_000),
  };
}
