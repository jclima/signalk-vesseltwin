import type { Category } from './mapping';

export interface PluginOptions {
  apiBaseUrl: string;
  categories: Record<Category, boolean>;
  samplePeriodSeconds: number;
  queueMaxReadings: number;
}

export const DEFAULT_API_BASE_URL = 'https://api.vesseltwin.io';

export const configSchema = {
  type: 'object',
  properties: {
    apiBaseUrl: {
      type: 'string',
      title: 'VesselTwin API URL',
      description: 'Leave the default unless you are testing against a staging server.',
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

/** Defensive: plugin settings arrive as untyped JSON. Unknown/invalid values fall back to defaults. */
export function parseOptions(raw: unknown): PluginOptions {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  let url = DEFAULT_API_BASE_URL;
  if (typeof o.apiBaseUrl === 'string') {
    try {
      const u = new URL(o.apiBaseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) {
        url = u.toString().replace(/\/$/, '');
      }
    } catch {
      // keep default
    }
  }
  return {
    apiBaseUrl: url,
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
