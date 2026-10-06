import type { Category } from './mapping';
import { V1_PATH_RULES } from './paths';
import type { SignalKApp } from './plugin';

/** The subscription API of signalk-server (recommended for plugins over `streambundle`). */
export interface SubscriptionManagerLike {
  subscribe(
    subscription: {
      context: string;
      subscribe: { path: string; period?: number }[];
    },
    unsubscribes: (() => void)[],
    onError: (err: unknown) => void,
    onDelta: (delta: unknown) => void,
  ): void;
}

export type CollectorApp = SignalKApp & { subscriptionmanager?: SubscriptionManagerLike };

/**
 * Subscribes to the permitted paths of the SELF vessel only (never `*` contexts, which would
 * include AIS targets, and never a catch-all path, which would include name and MMSI).
 * Returns a stop function; a server without `subscriptionmanager` yields a no-op.
 */
export function startCollector(
  app: CollectorApp,
  categories: Record<Category, boolean>,
  periodMs: number,
  onDelta: (delta: unknown) => void,
): () => void {
  const sm = app.subscriptionmanager;
  const paths = V1_PATH_RULES.filter((r) => categories[r.category]).map((r) => ({
    path: r.pattern,
    period: periodMs,
  }));
  if (!sm || paths.length === 0) return () => undefined;
  let unsubscribes: (() => void)[] = [];
  sm.subscribe(
    { context: 'vessels.self', subscribe: paths },
    unsubscribes,
    () => {
      app.error('VesselTwin: subscription error');
    },
    onDelta,
  );
  return () => {
    for (const u of unsubscribes) u();
    unsubscribes = [];
  };
}
