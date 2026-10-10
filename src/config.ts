import type { Category } from './mapping';

export interface PluginOptions {
  /** Validated API base URL; null when the configured value is invalid (see `configError`). */
  apiBaseUrl: string | null;
  /** Neutral, user-facing copy when a SET setting is invalid. No network calls while this is set. */
  configError: string | null;
  categories: Record<Category, boolean>;
  samplePeriodSeconds: number;
  queueMaxReadings: number;
  upload: UploadOptions;
  /** Neutral notes about the upload settings. Shown only in the admin /status response. */
  warnings: string[];
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

export type UploadCategory = 'engineHours' | 'batteries' | 'tanks';
export const UPLOAD_CATEGORIES: readonly UploadCategory[] = ['engineHours', 'batteries', 'tanks'];

/** Product limits of the planned upload. */
export const MAX_CHANNELS = 64;
export const MAX_READINGS_PER_CHANNEL_PER_DAY = 24;
export const MIN_RECORD_INTERVAL_MINUTES = 60;
export const MAX_RECORD_INTERVAL_MINUTES = 1440;
export const MAX_INSTANCE_IDS = 64;
/** Queue holds a week; the cap should fit every channel at the daily maximum. */
export const QUEUE_FLOOR_FOR_FULL_LOAD = MAX_CHANNELS * MAX_READINGS_PER_CHANNEL_PER_DAY * 7;

const SIMPLE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const TANK_ID = /^[A-Za-z][A-Za-z0-9]{0,30}\.[A-Za-z0-9_-]{1,40}$/;
const ID_PATTERN: Record<UploadCategory, RegExp> = {
  engineHours: SIMPLE_ID,
  batteries: SIMPLE_ID,
  tanks: TANK_ID,
};

export type InstanceMode = 'all' | 'selected';

export interface ChannelOptions {
  /** The parsed `enabled` setting (legacy toggle honoured). */
  enabled: boolean;
  /** `enabled`, and not "selected" with no valid ids. This is what the sampler obeys. */
  active: boolean;
  recordIntervalMinutes: number;
  instanceMode: InstanceMode;
  instanceIds: string[];
}

export interface UploadOptions {
  uploadIntervalMinutes: number;
  engineHours: ChannelOptions & { minChangeHours: number };
  batteries: ChannelOptions & { minChangeVolts: number; minChangePercent: number };
  tanks: ChannelOptions & { minChangePercent: number; minChangeLiters: number };
}

const NOT_ACTIVE = 'Not active yet.';

const ID_RULE = 'Use letters, digits, underscore or hyphen, up to 40 characters.';
const TANK_ID_RULE =
  'Use the tank type, a dot, then the tank id, for example "fuel.0". The type is letters and digits; the id is letters, digits, underscore or hyphen, up to 40 characters.';

function categorySchema(
  title: string,
  idPattern: string,
  idHelp: string,
  thresholds: Record<string, unknown>,
) {
  return {
    type: 'object',
    title,
    description: NOT_ACTIVE,
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enabled',
        default: true,
      },
      recordIntervalMinutes: {
        type: 'number',
        title: 'Record at most every (minutes)',
        description: 'Between 60 and 1440. The default is once a day.',
        default: MAX_RECORD_INTERVAL_MINUTES,
        minimum: MIN_RECORD_INTERVAL_MINUTES,
        maximum: MAX_RECORD_INTERVAL_MINUTES,
      },
      ...thresholds,
      instances: {
        type: 'object',
        title: 'Record from',
        properties: {
          mode: {
            type: 'string',
            title: 'Record from',
            enum: ['all', 'selected'],
            enumNames: ['All instances', 'Only the ids listed below'],
            default: 'all',
          },
          ids: {
            type: 'array',
            title: 'Instance ids',
            maxItems: MAX_INSTANCE_IDS,
            items: {
              type: 'string',
              title: 'Instance id',
              description: idHelp,
              pattern: idPattern,
              errorMessage: idHelp,
            },
          },
        },
      },
    },
  };
}

function threshold(title: string, min: number, max: number, zeroMeans?: string) {
  return {
    type: 'number',
    title,
    ...(zeroMeans === undefined ? {} : { description: zeroMeans }),
    default: min,
    minimum: min,
    maximum: max,
  };
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
    uploadIntervalMinutes: {
      type: 'number',
      title: 'Send to VesselTwin at most every (minutes)',
      description: `${NOT_ACTIVE} Between 5 and 1440. The default is once a day.`,
      default: 1440,
      minimum: 5,
      maximum: 1440,
    },
    engineHours: categorySchema(
      'Engine and generator hours',
      SIMPLE_ID.source,
      `${ID_RULE} For example "main".`,
      { minChangeHours: threshold('Minimum change (hours)', 0.1, 24) },
    ),
    batteries: categorySchema(
      'Battery voltage and state of charge',
      SIMPLE_ID.source,
      `${ID_RULE} For example "house".`,
      {
        minChangeVolts: threshold('Minimum voltage change (volts)', 0, 5, '0 = no minimum change.'),
        minChangePercent: threshold(
          'Minimum charge change (percent)',
          0,
          50,
          '0 = no minimum change.',
        ),
      },
    ),
    tanks: categorySchema('Tank levels', TANK_ID.source, TANK_ID_RULE, {
      minChangePercent: threshold(
        'Minimum level change (percent)',
        0,
        50,
        '0 = no minimum change.',
      ),
      minChangeLiters: threshold(
        'Minimum volume change (litres)',
        0,
        1000,
        '0 = no minimum change.',
      ),
    }),
    samplePeriodSeconds: {
      type: 'number',
      title: 'Sample period (seconds)',
      description: NOT_ACTIVE,
      default: 300,
      minimum: 10,
      maximum: 3600,
    },
    queueMaxReadings: {
      type: 'number',
      title: 'Offline queue cap (readings)',
      description: NOT_ACTIVE,
      default: 50000,
      minimum: 1000,
      maximum: 50000,
    },
  },
};

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

function num(v: unknown, d: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
}

/**
 * Absent, null, empty or whitespace-only means the production default. Any other value must be
 * https (or http on localhost, 127.0.0.1, [::1]) with no credentials, query or hash; anything
 * else is a config error and never silently falls back to production.
 */
function parseApiBaseUrl(v: unknown): { url: string | null; error: string | null } {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
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

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

const LABEL: Record<UploadCategory, string> = {
  engineHours: 'Engine and generator hours',
  batteries: 'Battery readings',
  tanks: 'Tank levels',
};

function parseChannel(
  cat: UploadCategory,
  raw: unknown,
  legacy: unknown,
  warnings: string[],
): ChannelOptions {
  const c = obj(raw);
  const enabled = typeof c.enabled === 'boolean' ? c.enabled : bool(legacy, true);
  const inst = obj(c.instances);
  const mode: InstanceMode = inst.mode === 'selected' ? 'selected' : 'all';
  const ids: string[] = [];
  let dropped = false;
  if (Array.isArray(inst.ids)) {
    for (const id of inst.ids as unknown[]) {
      if (typeof id === 'string' && ID_PATTERN[cat].test(id)) {
        if (!ids.includes(id)) ids.push(id);
      } else {
        dropped = true;
      }
    }
    if (ids.length > MAX_INSTANCE_IDS) {
      ids.length = MAX_INSTANCE_IDS;
      dropped = true;
    }
  }
  if (dropped) {
    warnings.push(`${LABEL[cat]}: some instance ids are not valid and were ignored.`);
  }
  const empty = mode === 'selected' && ids.length === 0;
  if (empty && enabled) {
    warnings.push(`${LABEL[cat]}: no valid instances are selected, so nothing will be recorded.`);
  }
  return {
    enabled,
    active: enabled && !empty,
    recordIntervalMinutes: num(
      c.recordIntervalMinutes,
      MAX_RECORD_INTERVAL_MINUTES,
      MIN_RECORD_INTERVAL_MINUTES,
      MAX_RECORD_INTERVAL_MINUTES,
    ),
    instanceMode: mode,
    instanceIds: ids,
  };
}

function parseUpload(
  o: Record<string, unknown>,
  queueMaxReadings: number,
): { upload: UploadOptions; warnings: string[] } {
  const warnings: string[] = [];
  const e = obj(o.engineHours);
  const b = obj(o.batteries);
  const t = obj(o.tanks);
  const upload: UploadOptions = {
    uploadIntervalMinutes: num(o.uploadIntervalMinutes, 1440, 5, 1440),
    engineHours: {
      ...parseChannel('engineHours', e, o.sendEngineHours, warnings),
      minChangeHours: num(e.minChangeHours, 0.1, 0.1, 24),
    },
    batteries: {
      ...parseChannel('batteries', b, o.sendBatteries, warnings),
      minChangeVolts: num(b.minChangeVolts, 0, 0, 5),
      minChangePercent: num(b.minChangePercent, 0, 0, 50),
    },
    tanks: {
      ...parseChannel('tanks', t, o.sendTanks, warnings),
      minChangePercent: num(t.minChangePercent, 0, 0, 50),
      minChangeLiters: num(t.minChangeLiters, 0, 0, 1000),
    },
  };
  if (queueMaxReadings < QUEUE_FLOOR_FOR_FULL_LOAD) {
    warnings.push(
      'The offline queue cap is lower than a week of readings from every channel at the daily maximum, so the oldest readings may be dropped.',
    );
  }
  return { upload, warnings };
}

/** Defensive: plugin settings arrive as untyped JSON. Unknown/invalid numbers and booleans fall back to defaults; an invalid API URL is an error. */
export function parseOptions(raw: unknown): PluginOptions {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { url, error } = parseApiBaseUrl(o.apiBaseUrl);
  const queueMaxReadings = num(o.queueMaxReadings, 50_000, 1_000, 50_000);
  const { upload, warnings } = parseUpload(o, queueMaxReadings);
  return {
    apiBaseUrl: url,
    configError: error,
    categories: {
      engineHours: upload.engineHours.enabled,
      batteries: upload.batteries.enabled,
      tanks: upload.tanks.enabled,
      // Hidden from the settings form; still parsed, never used.
      vesselInfo: bool(o.sendVesselInfo, false),
    },
    samplePeriodSeconds: num(o.samplePeriodSeconds, 300, 10, 3_600),
    queueMaxReadings,
    upload,
    warnings,
  };
}
