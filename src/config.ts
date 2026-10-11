export interface PluginOptions {
  /** Validated API base URL; null when the configured value is invalid (see `configError`). */
  apiBaseUrl: string | null;
  /** Neutral, user-facing copy when a SET setting is invalid. No network calls while this is set. */
  configError: string | null;
  categories: Record<UploadCategory | 'vesselInfo', boolean>;
  /** The master "Send readings to VesselTwin" switch. Nothing is active while this is off. */
  uploadEnabled: boolean;
  /** Categories that are really active: uploadEnabled, category enabled and valid instances. */
  activeCategories: UploadCategory[];
  queueMaxReadings: number;
  upload: UploadOptions;
  /**
   * Notes about the upload settings. Shown only in the admin /status response, never in the
   * status line. Prose, plus the code `legacy_send_settings` (see LEGACY_SEND_WARNING).
   */
  warnings: string[];
}

/** Warning code: saved 0.1.1 `send*` toggles were found and ignored (they were never consent). */
export const LEGACY_SEND_WARNING = 'legacy_send_settings';

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

/** Product limits of the upload. */
export const MAX_CHANNELS = 64;
export const MAX_READINGS_PER_CHANNEL_PER_DAY = 24;
export const MIN_RECORD_INTERVAL_MINUTES = 60;
export const MAX_RECORD_INTERVAL_MINUTES = 1440;
export const MAX_INSTANCE_IDS = 64;
/** Queue holds a week; the cap should fit every channel at the daily maximum. */
export const QUEUE_FLOOR_FOR_FULL_LOAD = MAX_CHANNELS * MAX_READINGS_PER_CHANNEL_PER_DAY * 7;

const SIMPLE_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** The tank types of the contract; keep in step with `TANK` in mapping.ts (a test compares them). */
export const TANK_TYPES: readonly string[] = [
  'fuel',
  'freshWater',
  'wasteWater',
  'blackWater',
  'lubrication',
  'liveWell',
  'baitWell',
  'gas',
  'ballast',
];
const TANK_ID = new RegExp(`^(?:${TANK_TYPES.join('|')})\\.[A-Za-z0-9_-]{1,40}$`);
const ID_PATTERN: Record<UploadCategory, RegExp> = {
  engineHours: SIMPLE_ID,
  batteries: SIMPLE_ID,
  tanks: TANK_ID,
};

export type InstanceMode = 'all' | 'selected';

export interface ChannelOptions {
  /** The parsed per-category `enabled` setting. */
  enabled: boolean;
  /** `uploadEnabled`, `enabled`, and not "selected" with no valid ids. This is what the sampler obeys. */
  active: boolean;
  recordIntervalMinutes: number;
  instanceMode: InstanceMode;
  instanceIds: string[];
}

export interface UploadOptions {
  /** The master switch; every category's `active` is false while it is off. */
  uploadEnabled: boolean;
  uploadIntervalMinutes: number;
  engineHours: ChannelOptions & { minChangeHours: number };
  batteries: ChannelOptions & { minChangeVolts: number; minChangePercent: number };
  tanks: ChannelOptions & { minChangePercent: number; minChangeLiters: number };
}

const ID_RULE = 'Use letters, digits, underscore or hyphen, up to 40 characters.';
const TANK_ID_RULE = `Use the tank type, a dot, then the tank id, for example "fuel.0". The type is one of ${TANK_TYPES.join(', ')}; the id is letters, digits, underscore or hyphen, up to 40 characters.`;

function categorySchema(
  title: string,
  idPattern: string,
  idHelp: string,
  thresholds: Record<string, unknown>,
) {
  return {
    type: 'object',
    title,
    description:
      'Used only when "Send readings to VesselTwin" is on. By default it records at most once a day.',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enabled',
        default: false,
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
            // The form renders an array-level description twice (under the array and
            // under its neighbour), so the hint lives in the title, which renders once.
            title:
              'Instance ids (only used with "Only the ids listed below"; add at least one, or nothing is recorded)',
            maxItems: MAX_INSTANCE_IDS,
            items: {
              type: 'string',
              title: 'Instance id',
              description: idHelp,
              pattern: idPattern,
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
    uploadEnabled: {
      type: 'boolean',
      title: 'Send readings to VesselTwin',
      description:
        'Nothing is sent until this is on. Then the categories you enable below are sent to VesselTwin: the SignalK path (including the instance id), the value and the time of each reading. Never position, MMSI, names or AIS.',
      default: false,
    },
    uploadIntervalMinutes: {
      type: 'number',
      title: 'Send to VesselTwin at most every (minutes)',
      description: 'Between 5 and 1440. The default is once a day.',
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
      'Battery readings',
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
    queueMaxReadings: {
      type: 'number',
      title: 'Offline queue cap (readings)',
      description:
        'Readings wait here while VesselTwin cannot be reached. The oldest are dropped first; they are also dropped after 7 days.',
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
  uploadEnabled: boolean,
  warnings: string[],
): ChannelOptions {
  const c = obj(raw);
  // Legacy `send*` keys are deliberately not read: 0.1.1 saved them as defaults, not consent.
  const enabled = bool(c.enabled, false);
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
  if (empty && enabled && uploadEnabled) {
    warnings.push(`${LABEL[cat]}: no valid instances are selected, so nothing will be recorded.`);
  }
  return {
    enabled,
    active: uploadEnabled && enabled && !empty,
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
  const uploadEnabled = bool(o.uploadEnabled, false);
  const e = obj(o.engineHours);
  const b = obj(o.batteries);
  const t = obj(o.tanks);
  const upload: UploadOptions = {
    uploadEnabled,
    uploadIntervalMinutes: num(o.uploadIntervalMinutes, 1440, 5, 1440),
    engineHours: {
      ...parseChannel('engineHours', e, uploadEnabled, warnings),
      minChangeHours: num(e.minChangeHours, 0.1, 0.1, 24),
    },
    batteries: {
      ...parseChannel('batteries', b, uploadEnabled, warnings),
      minChangeVolts: num(b.minChangeVolts, 0, 0, 5),
      minChangePercent: num(b.minChangePercent, 0, 0, 50),
    },
    tanks: {
      ...parseChannel('tanks', t, uploadEnabled, warnings),
      minChangePercent: num(t.minChangePercent, 0, 0, 50),
      minChangeLiters: num(t.minChangeLiters, 0, 0, 1000),
    },
  };
  if ([o.sendEngineHours, o.sendBatteries, o.sendTanks].some((v) => v === true)) {
    warnings.push(LEGACY_SEND_WARNING);
  }
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
    uploadEnabled: upload.uploadEnabled,
    activeCategories: UPLOAD_CATEGORIES.filter((c) => upload[c].active),
    queueMaxReadings,
    upload,
    warnings,
  };
}
