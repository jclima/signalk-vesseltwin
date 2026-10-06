import type { Reading } from './normalize';
import type { Quantity } from './paths';

export interface SamplerOptions {
  /** Cumulative counters: emit on a change of at least this many hours. */
  hoursDelta: number;
  /** Cumulative counters: emit at least once per this many ms (heartbeat). */
  hoursHeartbeatMs: number;
  /** Levels: emit at least once per this many ms. */
  levelIntervalMs: number;
  /** Levels: also emit on a change this large (percent points / volts / litres per quantity). */
  levelDelta: Record<
    'battery_voltage' | 'battery_state_of_charge' | 'tank_level' | 'tank_volume',
    number
  >;
  /** Delta-triggered level emits are spaced at least this far apart. */
  minGapMs: number;
  /** Hard cap on tracked channels (flood guard). */
  maxChannels: number;
}

export const DEFAULT_SAMPLER: SamplerOptions = {
  hoursDelta: 0.1,
  hoursHeartbeatMs: 24 * 3600_000,
  levelIntervalMs: 3600_000,
  levelDelta: { battery_voltage: 0.3, battery_state_of_charge: 5, tank_level: 5, tank_volume: 20 },
  minGapMs: 60_000,
  maxChannels: 256,
};

const CUMULATIVE: ReadonlySet<Quantity> = new Set(['engine_hours', 'generator_hours']);

interface Last {
  canonical: number;
  at: number;
}

/**
 * Per-channel downsampler. Time comes from each reading's `observedAt`, never from the wall
 * clock. A counter that goes backwards is NOT corrected here: it is simply emitted like any
 * other change (>= delta) so the server can hold it for review.
 */
export class Sampler {
  private readonly last = new Map<string, Last>();
  private readonly o: SamplerOptions;

  constructor(opts: Partial<SamplerOptions> = {}) {
    this.o = {
      ...DEFAULT_SAMPLER,
      ...opts,
      levelDelta: { ...DEFAULT_SAMPLER.levelDelta, ...opts.levelDelta },
    };
  }

  /** True when the reading should be queued. Records it as the new baseline when so. */
  accept(r: Reading): boolean {
    const key = `${r.channel}#${r.quantity}`;
    const at = Date.parse(r.observedAt);
    const prev = this.last.get(key);
    let emit: boolean;
    if (!prev) {
      if (this.last.size >= this.o.maxChannels) return false;
      emit = true;
    } else {
      const dt = at - prev.at;
      const diff = Math.abs(r.canonical - prev.canonical) + 1e-9; // float-noise tolerance
      if (CUMULATIVE.has(r.quantity)) {
        emit = diff >= this.o.hoursDelta || dt >= this.o.hoursHeartbeatMs;
      } else {
        const limit = this.o.levelDelta[r.quantity as keyof SamplerOptions['levelDelta']];
        emit = dt >= this.o.levelIntervalMs || (diff >= limit && dt >= this.o.minGapMs);
      }
    }
    if (emit) this.last.set(key, { canonical: r.canonical, at });
    return emit;
  }
}
