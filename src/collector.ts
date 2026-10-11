import type { PathRule } from './mapping';
import { redactError } from './redact';

/**
 * Subscribes to the SignalK server's own vessel for the permitted path globs and hands every delta
 * to `onDelta`. The subscription is the trust boundary: `vessels.self` is filtered by the server,
 * so no vessel identity is read here. The sampler's path allowlist is the privacy boundary.
 */

/** The slice of the SignalK subscription manager this plugin uses. */
export interface SubscriptionManagerLike {
  subscribe(
    command: {
      context: 'vessels.self';
      subscribe: { path: string; policy: 'instant'; minPeriod: number }[];
    },
    unsubscribes: (() => void)[],
    onError: (err: unknown) => void,
    onDelta: (delta: unknown) => void,
  ): void;
}

export interface CollectorOptions {
  sm: SubscriptionManagerLike;
  /** The rules of the active categories only. */
  rules: readonly PathRule[];
  /** Server-side rate limit per path. The sampler thins further by its own record interval. */
  minPeriodMs?: number;
  onDelta: (delta: unknown) => void;
  /** Receives redacted text only. */
  onError: (message: string) => void;
}

export const DEFAULT_MIN_PERIOD_MS = 60_000;

export function startCollector(o: CollectorOptions): { stop(): void } {
  const unsubscribes: (() => void)[] = [];
  let stopped = false;
  const globs = [...new Set(o.rules.map((r) => r.subscribe))];
  if (globs.length === 0) return { stop: () => undefined };
  const minPeriod = o.minPeriodMs ?? DEFAULT_MIN_PERIOD_MS;
  try {
    o.sm.subscribe(
      {
        context: 'vessels.self',
        subscribe: globs.map((path) => ({ path, policy: 'instant' as const, minPeriod })),
      },
      unsubscribes,
      (err) => {
        if (!stopped) o.onError(redactError(err));
      },
      (delta) => {
        if (stopped) return;
        try {
          o.onDelta(delta);
        } catch (err) {
          o.onError(redactError(err));
        }
      },
    );
  } catch (err) {
    stopped = true;
    o.onError(redactError(err));
    return { stop: () => undefined };
  }
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const u of unsubscribes.splice(0)) {
        try {
          u();
        } catch {
          // best effort: the server is shutting the subscription down anyway
        }
      }
    },
  };
}
