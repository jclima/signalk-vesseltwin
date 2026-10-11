import { describe, expect, it, vi } from 'vitest';
import { startCollector, type SubscriptionManagerLike } from '../src/collector';
import { PATH_RULES } from '../src/mapping';

type SubscribeArgs = Parameters<SubscriptionManagerLike['subscribe']>;

function fakeSm() {
  const calls: SubscribeArgs[] = [];
  const sm: SubscriptionManagerLike = {
    subscribe: (...args) => {
      calls.push(args);
    },
  };
  return { sm, calls };
}

describe('startCollector', () => {
  it('subscribes to vessels.self with one instant entry per active glob', () => {
    const { sm, calls } = fakeSm();
    startCollector({
      sm,
      rules: PATH_RULES.filter((r) => r.category === 'batteries'),
      onDelta: () => undefined,
      onError: () => undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      context: 'vessels.self',
      subscribe: [
        { path: 'electrical.batteries.*.voltage', policy: 'instant', minPeriod: 60_000 },
        {
          path: 'electrical.batteries.*.capacity.stateOfCharge',
          policy: 'instant',
          minPeriod: 60_000,
        },
      ],
    });
  });

  it('never subscribes to anything outside the rules it was given', () => {
    const { sm, calls } = fakeSm();
    startCollector({ sm, rules: PATH_RULES, onDelta: () => undefined, onError: () => undefined });
    const paths = (calls[0]?.[0].subscribe ?? []).map((s) => s.path);
    expect(paths).toEqual(PATH_RULES.map((r) => r.subscribe));
    for (const p of paths)
      expect(p).not.toMatch(/navigation|position|mmsi|design|communication|\*\.\*$/);
  });

  it('does not subscribe with no rules', () => {
    const { sm, calls } = fakeSm();
    const c = startCollector({ sm, rules: [], onDelta: () => undefined, onError: () => undefined });
    expect(calls).toHaveLength(0);
    c.stop();
  });

  it('passes deltas through until stopped, and stop() runs every unsubscribe once', () => {
    const { sm, calls } = fakeSm();
    const onDelta = vi.fn();
    const c = startCollector({ sm, rules: PATH_RULES, onDelta, onError: () => undefined });
    const [, unsubs, , deliver] = calls[0] as SubscribeArgs;
    const u1 = vi.fn();
    const u2 = vi.fn();
    unsubs.push(u1, u2);
    deliver({ n: 1 });
    expect(onDelta).toHaveBeenCalledTimes(1);
    c.stop();
    c.stop();
    expect(u1).toHaveBeenCalledTimes(1);
    expect(u2).toHaveBeenCalledTimes(1);
    deliver({ n: 2 });
    expect(onDelta).toHaveBeenCalledTimes(1);
  });

  it('redacts errors before they are reported, including a throwing delta handler', () => {
    const { sm, calls } = fakeSm();
    const seen: string[] = [];
    startCollector({
      sm,
      rules: PATH_RULES,
      onDelta: () => {
        throw new Error('boom vti_AAAAAAAAAAAAAAAAAAAA');
      },
      onError: (m) => seen.push(m),
    });
    const [, , onError, deliver] = calls[0] as SubscribeArgs;
    onError(new Error('Authorization: Bearer vti_BBBBBBBBBBBBBBBBBBBB'));
    deliver({});
    expect(seen).toHaveLength(2);
    expect(seen.join('\n')).not.toMatch(/vti_[A-Z]{8}/);
  });

  it('reports a failing subscribe and stays inert', () => {
    const seen: string[] = [];
    const c = startCollector({
      sm: {
        subscribe: () => {
          throw new Error('no');
        },
      },
      rules: PATH_RULES,
      onDelta: () => undefined,
      onError: (m) => seen.push(m),
    });
    expect(seen).toHaveLength(1);
    expect(() => {
      c.stop();
    }).not.toThrow();
  });
});
