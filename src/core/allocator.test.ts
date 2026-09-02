import { describe, expect, it } from 'vitest';
import { CallAllocator, InMemoryDialerStore } from './allocator';
import type { Agent, Borrower } from './types';

function agent(id: string): Agent {
  return {
    id,
    state: 'AVAILABLE',
    version: 0,
    stateSince: 0,
    callsHandled: 0,
  };
}

function borrower(id: string): Borrower {
  return {
    id,
    state: 'READY',
    version: 0,
    priority: 50,
    attempts: 0,
  };
}

describe('CallAllocator', () => {
  it('reserves agent, borrower, and call atomically for progressive dialing', () => {
    const store = new InMemoryDialerStore();
    store.addAgent(agent('agent-1'));
    store.addBorrower(borrower('borrower-1'));
    const allocator = new CallAllocator(store);

    const result = allocator.reservePair({
      agentId: 'agent-1',
      borrowerId: 'borrower-1',
      workerId: 'worker-1',
      now: 1_000,
      leaseMs: 8_000,
      expectedAgentVersion: 0,
      expectedBorrowerVersion: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.call?.state).toBe('RESERVED');
    expect(store.getAgent('agent-1')?.state).toBe('RESERVED');
    expect(store.getBorrower('borrower-1')?.state).toBe('RESERVED');
  });

  it('prevents duplicate assignment when borrower version is stale', () => {
    const store = new InMemoryDialerStore();
    store.addAgent(agent('agent-1'));
    store.addBorrower(borrower('borrower-1'));
    const allocator = new CallAllocator(store);

    allocator.reserveBorrower('borrower-1', 'worker-1', 0, 8_000, 0);
    const duplicate = allocator.reserveBorrower('borrower-1', 'worker-2', 0, 8_000, 0);

    expect(duplicate.ok).toBe(false);
    expect(duplicate.reason).toBe('BORROWER_VERSION_CONFLICT');
  });
});
