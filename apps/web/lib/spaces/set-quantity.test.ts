import { ORPCError } from '@orpc/client';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import type { PositionsListOutput } from '@waddlers/contracts';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FORBIDDEN_MESSAGE, MUTATION_ERROR_MESSAGE } from './errors';
import { setQuantityMutationOptions, type QuantityVars } from './set-quantity';
import { listOutput } from './test-fixtures';

const SPACE = '11111111-1111-4111-8111-111111111111';
const X = '22222222-2222-4222-8222-222222222222';
const Y = '33333333-3333-4333-8333-333333333333';
const listKey = ['positions', 'list', SPACE];

function row(id: string, quantity: string | null) {
  return {
    id,
    quantity,
    selectionReason: null,
    addedAt: '2026-01-01T00:00:00.000Z',
    instrument: { id, name: id, type: 'stock', isin: null },
    listing: {
      id,
      symbol: 'S',
      exchange: { mic: 'XPAR', name: 'Euronext Paris' },
      currency: 'EUR',
      currencyMajor: 'EUR',
      minorUnitDivisor: 1,
    },
    values: {},
  } as unknown as PositionsListOutput['rows'][number];
}

type Deferred = { resolve: () => void; reject: (e: unknown) => void };
function deferred(): Promise<void> & Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as Promise<void> & Deferred;
  p.resolve = resolve;
  p.reject = reject;
  return p;
}

const quantityOf = (qc: QueryClient, id: string) =>
  qc.getQueryData<PositionsListOutput>(listKey)?.rows.find((r) => r.id === id)?.quantity;

describe('useSetQuantity state machine (setQuantityMutationOptions)', () => {
  let qc: QueryClient;
  let notify: { success: Mock<(m: string) => void>; error: Mock<(m: string) => void> };
  let invalidate: Mock<() => void>;
  let saved: Mock<() => void>;
  let calls: { vars: QuantityVars; gate: ReturnType<typeof deferred> }[];

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData<PositionsListOutput>(listKey, listOutput([row(X, '1'), row(Y, '7')]));
    notify = { success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() };
    invalidate = vi.fn<() => void>();
    saved = vi.fn<() => void>();
    calls = [];
  });

  function edit(positionId: string, quantity: string | null) {
    const observer = new MutationObserver(
      qc,
      setQuantityMutationOptions({
        queryClient: qc,
        spaceId: SPACE,
        positionId,
        listKey,
        mutationKey: ['positions', 'setQuantity'],
        mutationFn: (vars) => {
          const gate = deferred();
          calls.push({ vars, gate });
          return gate;
        },
        notify,
        invalidate,
        onSaved: saved,
      }),
    );
    const done = observer.mutate({ spaceId: SPACE, positionId, quantity }).catch(() => undefined);
    return { done, observer };
  }

  const started = (n: number) => vi.waitFor(() => expect(calls).toHaveLength(n));

  it('applies the value optimistically, then confirms on success', async () => {
    const { done } = edit(X, '5');
    await started(1);
    expect(quantityOf(qc, X)).toBe('5'); // shown before the server answered
    calls[0]!.gate.resolve();
    await done;
    expect(quantityOf(qc, X)).toBe('5');
    expect(notify.success).toHaveBeenCalledWith('Quantité mise à jour.');
    expect(saved).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('rolls back a failed edit (that row only) and toasts a French message', async () => {
    const { done } = edit(X, '5');
    await started(1);
    // Another row changes meanwhile (e.g. its own edit): must not be reverted.
    qc.setQueryData<PositionsListOutput>(listKey, (old) => ({
      ...old!,
      rows: old!.rows.map((r) => (r.id === Y ? { ...r, quantity: '8' } : r)),
    }));
    calls[0]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await done;
    expect(quantityOf(qc, X)).toBe('1');
    expect(quantityOf(qc, Y)).toBe('8');
    expect(notify.error).toHaveBeenCalledWith(MUTATION_ERROR_MESSAGE);
    expect(notify.success).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('says FORBIDDEN in French and stays quiet on NOT_FOUND', async () => {
    const first = edit(X, '5');
    await started(1);
    calls[0]!.gate.reject(new ORPCError('FORBIDDEN'));
    await first.done;
    expect(notify.error).toHaveBeenCalledWith(FORBIDDEN_MESSAGE);

    notify.error.mockClear();
    const second = edit(X, '6');
    await started(2);
    calls[1]!.gate.reject(new ORPCError('NOT_FOUND'));
    await second.done;
    expect(notify.error).not.toHaveBeenCalled();
    expect(quantityOf(qc, X)).toBe('1');
  });

  it('keeps the second value when the first of two overlapping edits fails', async () => {
    const first = edit(X, '2');
    const second = edit(X, '3');
    await started(1); // serialized: the second write waits for the first
    expect(quantityOf(qc, X)).toBe('3');
    calls[0]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await first.done;
    expect(quantityOf(qc, X)).toBe('3'); // not rolled back to 1
    expect(invalidate).not.toHaveBeenCalled(); // the second is still in flight
    await started(2);
    expect(calls[1]!.vars.quantity).toBe('3');
    calls[1]!.gate.resolve();
    await second.done;
    expect(quantityOf(qc, X)).toBe('3');
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('keeps a value shared by both overlapping edits while the second is still pending', async () => {
    const first = edit(X, '2');
    const second = edit(X, '2');
    await started(1);
    calls[0]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await first.done;
    expect(quantityOf(qc, X)).toBe('2');
    await started(2);
    calls[1]!.gate.resolve();
    await second.done;
    expect(quantityOf(qc, X)).toBe('2');
  });

  it('never leaves an unsaved value when both overlapping edits fail', async () => {
    const first = edit(X, '2');
    const second = edit(X, '3');
    await started(1);
    calls[0]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await first.done;
    await started(2);
    calls[1]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await second.done;
    // Neither '2' (first's unsaved value, the second's "previous") nor '3': the stored value.
    expect(quantityOf(qc, X)).toBe('1');
    expect(notify.error).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('does not roll back over a value that changed (refetch) after the edit', async () => {
    const { done } = edit(X, '5');
    await started(1);
    qc.setQueryData<PositionsListOutput>(listKey, (old) => ({
      ...old!,
      rows: old!.rows.map((r) => (r.id === X ? { ...r, quantity: '9' } : r)),
    }));
    calls[0]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await done;
    expect(quantityOf(qc, X)).toBe('9');
  });

  it('a clear (null) is an ordinary value: rolled back to the previous quantity', async () => {
    const { done } = edit(X, null);
    await started(1);
    expect(quantityOf(qc, X)).toBeNull();
    calls[0]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await done;
    expect(quantityOf(qc, X)).toBe('1');
  });

  it('edits of different positions are independent (not serialized together)', async () => {
    const a = edit(X, '2');
    const b = edit(Y, '9');
    await started(2);
    calls[1]!.gate.reject(new ORPCError('INTERNAL_SERVER_ERROR'));
    await b.done;
    expect(quantityOf(qc, Y)).toBe('7');
    expect(quantityOf(qc, X)).toBe('2');
    calls[0]!.gate.resolve();
    await a.done;
  });
});
