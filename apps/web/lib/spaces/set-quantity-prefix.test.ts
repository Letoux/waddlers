import { MutationObserver, QueryClient } from '@tanstack/react-query';
import type { PositionsListOutput } from '@waddlers/contracts';
import { describe, expect, it, vi } from 'vitest';
import { orpc } from '@/lib/orpc';
import { RECALCULATING_REASON } from '@/lib/table/cells';
import { setQuantityMutationOptions } from './set-quantity';
import { listOutput } from './test-fixtures';

const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const P = '22222222-2222-4222-8222-222222222222';

const TRACKED = (amount: string | null) => ({
  amount,
  currency: 'EUR',
  asOf: '2026-09-29',
  isStale: false,
  reason: null,
});
const page = (quantity: string | null, tracked: string | null = '80'): PositionsListOutput =>
  listOutput([
    { id: P, quantity, values: { name: 'X', tracked_value_eur: TRACKED(tracked) } },
  ] as never);

// Table cache keys of one space: different period, search, sort and page.
const input = (extra: object) => ({ spaceId: SPACE, ...extra });
const keys = [
  orpc.positions.list.queryKey({ input: input({ period: '1m' }) }),
  orpc.positions.list.queryKey({
    input: input({ period: '1y', sort: { columnId: 'perf_period', direction: 'desc' } }),
  }),
  orpc.positions.list.queryKey({
    input: input({ search: 'usd', page: { offset: 50, limit: 50 }, columns: ['name'] }),
  }),
];
const otherSpaceKey = orpc.positions.list.queryKey({ input: { spaceId: OTHER, period: '1m' } });

describe('optimistic set-quantity over paginated/sorted cache entries', () => {
  it('oRPC key({ input: { spaceId } }) prefix-matches every entry of the space, no other', () => {
    const qc = new QueryClient();
    for (const k of keys) qc.setQueryData(k, page('1'));
    qc.setQueryData(otherSpaceKey, page('1'));
    const prefix = orpc.positions.list.key({ input: { spaceId: SPACE } });
    expect(qc.getQueriesData({ queryKey: prefix })).toHaveLength(keys.length);
    // The spaces list and dashboard keys are not under the positions prefix.
    expect(qc.getQueriesData({ queryKey: orpc.spaces.list.key() })).toHaveLength(0);
  });

  it('updates the row (and values.quantity) in all of them and leaves other spaces alone', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    for (const k of keys) qc.setQueryData(k, page('1'));
    qc.setQueryData(otherSpaceKey, page('1'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const observer = new MutationObserver(
      qc,
      setQuantityMutationOptions({
        queryClient: qc,
        spaceId: SPACE,
        positionId: P,
        listKey: orpc.positions.list.key({ input: { spaceId: SPACE } }),
        mutationKey: ['positions', 'setQuantity'],
        mutationFn: () => gate,
        notify: { success: vi.fn(), error: vi.fn() },
        invalidate: vi.fn(),
      }),
    );
    const done = observer.mutate({ spaceId: SPACE, positionId: P, quantity: '9' });
    await vi.waitFor(() => {
      for (const k of keys) {
        const d = qc.getQueryData<PositionsListOutput>(k)!;
        expect(d.rows[0]!.quantity).toBe('9');
        // Valeur suivie is pending (never computed client-side); quantity is row.quantity only.
        expect(d.rows[0]!.values.tracked_value_eur).toMatchObject({
          amount: null,
          reason: RECALCULATING_REASON,
        });
        expect(d.rows[0]!.values).not.toHaveProperty('quantity');
      }
    });
    expect(qc.getQueryData<PositionsListOutput>(otherSpaceKey)!.rows[0]!.quantity).toBe('1');
    release();
    await done;
  });

  it('a failed edit rolls every entry back', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    for (const k of keys) qc.setQueryData(k, page('1'));
    const observer = new MutationObserver(
      qc,
      setQuantityMutationOptions({
        queryClient: qc,
        spaceId: SPACE,
        positionId: P,
        listKey: orpc.positions.list.key({ input: { spaceId: SPACE } }),
        mutationKey: ['positions', 'setQuantity'],
        mutationFn: () => Promise.reject(new Error('boom')),
        notify: { success: vi.fn(), error: vi.fn() },
        invalidate: vi.fn(),
      }),
    );
    await observer.mutate({ spaceId: SPACE, positionId: P, quantity: '9' }).catch(() => undefined);
    for (const k of keys) {
      const row = qc.getQueryData<PositionsListOutput>(k)!.rows[0]!;
      expect(row.quantity).toBe('1');
      expect(row.values.tracked_value_eur).toEqual(TRACKED('80')); // both fields restored
    }
  });

  it('after a success then a failure, the quantity falls back and the tracked value stays pending', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(keys[0]!, page('1'));
    let fail = false;
    const observer = new MutationObserver(
      qc,
      setQuantityMutationOptions({
        queryClient: qc,
        spaceId: SPACE,
        positionId: P,
        listKey: orpc.positions.list.key({ input: { spaceId: SPACE } }),
        mutationKey: ['positions', 'setQuantity'],
        mutationFn: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve()),
        notify: { success: vi.fn(), error: vi.fn() },
        invalidate: vi.fn(),
      }),
    );
    await observer.mutate({ spaceId: SPACE, positionId: P, quantity: '5' });
    fail = true;
    await observer.mutate({ spaceId: SPACE, positionId: P, quantity: '9' }).catch(() => undefined);
    const row = qc.getQueryData<PositionsListOutput>(keys[0]!)!.rows[0]!;
    expect(row.quantity).toBe('5');
    // The value of quantity 5 is unknown until the refetch: not the old 80, not computed.
    expect(row.values.tracked_value_eur).toMatchObject({ reason: RECALCULATING_REASON });
  });
});
