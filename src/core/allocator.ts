import { transitionAgent } from './state-machines';
import type {
  Agent,
  AgentAssignmentResult,
  BatchReservationResult,
  Borrower,
  DialerCall,
  ReservationRequest,
  ReservationResult,
} from './types';

/**
 * In-memory authoritative store used by the simulator. Methods intentionally
 * return live entities to keep a 10k-agent simulation cheap; snapshots clone them.
 */
export class InMemoryDialerStore {
  readonly agents = new Map<string, Agent>();
  readonly borrowers = new Map<string, Borrower>();
  readonly calls = new Map<string, DialerCall>();

  clear(): void {
    this.agents.clear();
    this.borrowers.clear();
    this.calls.clear();
  }

  addAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
  }

  addBorrower(borrower: Borrower): void {
    this.borrowers.set(borrower.id, borrower);
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  getBorrower(id: string): Borrower | undefined {
    return this.borrowers.get(id);
  }

  getCall(id: string): DialerCall | undefined {
    return this.calls.get(id);
  }
}

/**
 * The allocation critical section contains no await point. It validates both
 * versions and both states before committing agent, borrower and call together.
 * In a database this maps directly to one transaction with version predicates.
 */
export class CallAllocator {
  private callSequence = 0;

  constructor(readonly store: InMemoryDialerStore) {}

  resetSequence(): void {
    this.callSequence = 0;
  }

  reservePair(request: ReservationRequest): ReservationResult {
    const agent = this.store.agents.get(request.agentId);
    const borrower = this.store.borrowers.get(request.borrowerId);

    if (request.expectedAgentVersion !== undefined && agent?.version !== request.expectedAgentVersion) {
      return { ok: false, reason: 'AGENT_VERSION_CONFLICT' };
    }
    if (request.expectedBorrowerVersion !== undefined && borrower?.version !== request.expectedBorrowerVersion) {
      return { ok: false, reason: 'BORROWER_VERSION_CONFLICT' };
    }
    if (!agent || agent.state !== 'AVAILABLE') {
      return { ok: false, reason: 'AGENT_NOT_AVAILABLE' };
    }
    if (!borrower || borrower.state !== 'READY') {
      return { ok: false, reason: 'BORROWER_NOT_READY' };
    }

    const callId = `call-${++this.callSequence}`;
    const leaseExpiresAt = request.now + request.leaseMs;
    const call: DialerCall = {
      id: callId,
      borrowerId: borrower.id,
      agentId: agent.id,
      state: 'RESERVED',
      version: 1,
      createdAt: request.now,
      updatedAt: request.now,
      stateSince: request.now,
      workerId: request.workerId,
      leaseExpiresAt,
      recoveredCount: 0,
      processedEventIds: new Set<string>(),
      transitions: [
        {
          from: 'QUEUED',
          to: 'RESERVED',
          at: request.now,
          source: 'ALLOCATOR',
        },
      ],
    };

    // Commit point: all preconditions have passed; these synchronous mutations
    // form one atomic unit in JS and model a DB transaction/CAS in production.
    transitionAgent(agent, 'RESERVED', request.now);
    agent.reservedCallId = callId;
    agent.leaseExpiresAt = leaseExpiresAt;
    borrower.state = 'RESERVED';
    borrower.reservedCallId = callId;
    borrower.leaseExpiresAt = leaseExpiresAt;
    borrower.version += 1;
    this.store.calls.set(callId, call);

    return { ok: true, call };
  }

  reserveBorrower(
    borrowerId: string,
    workerId: string,
    now: number,
    leaseMs: number,
    expectedBorrowerVersion?: number,
  ): ReservationResult {
    const borrower = this.store.borrowers.get(borrowerId);
    if (expectedBorrowerVersion !== undefined && borrower?.version !== expectedBorrowerVersion) {
      return { ok: false, reason: 'BORROWER_VERSION_CONFLICT' };
    }
    if (!borrower || borrower.state !== 'READY') {
      return { ok: false, reason: 'BORROWER_NOT_READY' };
    }

    const callId = `call-${++this.callSequence}`;
    const leaseExpiresAt = now + leaseMs;
    const call: DialerCall = {
      id: callId,
      borrowerId: borrower.id,
      state: 'RESERVED',
      version: 1,
      createdAt: now,
      updatedAt: now,
      stateSince: now,
      workerId,
      leaseExpiresAt,
      recoveredCount: 0,
      processedEventIds: new Set<string>(),
      transitions: [{ from: 'QUEUED', to: 'RESERVED', at: now, source: 'ALLOCATOR' }],
    };

    borrower.state = 'RESERVED';
    borrower.reservedCallId = callId;
    borrower.leaseExpiresAt = leaseExpiresAt;
    borrower.version += 1;
    this.store.calls.set(callId, call);
    return { ok: true, call };
  }

  reserveBorrowerBatch(
    limit: number,
    workerIds: readonly string[],
    now: number,
    leaseMs: number,
  ): BatchReservationResult {
    if (limit <= 0 || workerIds.length === 0) return { calls: [], conflicts: 0 };
    const calls: DialerCall[] = [];
    let conflicts = 0;
    for (const borrower of this.store.borrowers.values()) {
      if (calls.length >= limit) break;
      if (borrower.state !== 'READY') continue;
      const result = this.reserveBorrower(
        borrower.id,
        workerIds[calls.length % workerIds.length],
        now,
        leaseMs,
        borrower.version,
      );
      if (result.ok && result.call) calls.push(result.call);
      else conflicts += 1;
    }
    return { calls, conflicts };
  }

  assignAgent(
    callId: string,
    agentId: string,
    now: number,
    leaseMs: number,
    expectedAgentVersion?: number,
    expectedCallVersion?: number,
  ): AgentAssignmentResult {
    const call = this.store.calls.get(callId);
    const agent = this.store.agents.get(agentId);
    if (expectedCallVersion !== undefined && call?.version !== expectedCallVersion) {
      return { ok: false, reason: 'CALL_VERSION_CONFLICT' };
    }
    if (!call || call.agentId || call.state !== 'ANSWERED') {
      return { ok: false, reason: 'CALL_NOT_ASSIGNABLE' };
    }
    if (!agent || agent.state !== 'AVAILABLE') {
      return { ok: false, reason: 'AGENT_NOT_AVAILABLE' };
    }
    if (expectedAgentVersion !== undefined && agent.version !== expectedAgentVersion) {
      return { ok: false, reason: 'AGENT_VERSION_CONFLICT' };
    }

    transitionAgent(agent, 'RESERVED', now);
    agent.reservedCallId = call.id;
    agent.leaseExpiresAt = now + leaseMs;
    call.agentId = agent.id;
    call.leaseExpiresAt = now + leaseMs;
    call.updatedAt = now;
    call.version += 1;
    return { ok: true, call };
  }

  reserveNextBatch(limit: number, workerIds: readonly string[], now: number, leaseMs: number): BatchReservationResult {
    if (limit <= 0 || workerIds.length === 0) return { calls: [], conflicts: 0 };
    const agents: Agent[] = [];
    const borrowers: Borrower[] = [];

    for (const agent of this.store.agents.values()) {
      if (agent.state === 'AVAILABLE') {
        agents.push(agent);
        if (agents.length >= limit) break;
      }
    }
    for (const borrower of this.store.borrowers.values()) {
      if (borrower.state === 'READY') {
        borrowers.push(borrower);
        if (borrowers.length >= limit) break;
      }
    }

    const pairCount = Math.min(limit, agents.length, borrowers.length);
    const calls: DialerCall[] = [];
    let conflicts = 0;
    for (let index = 0; index < pairCount; index += 1) {
      const agent = agents[index];
      const borrower = borrowers[index];
      const result = this.reservePair({
        agentId: agent.id,
        borrowerId: borrower.id,
        workerId: workerIds[index % workerIds.length],
        now,
        leaseMs,
        expectedAgentVersion: agent.version,
        expectedBorrowerVersion: borrower.version,
      });
      if (result.ok && result.call) calls.push(result.call);
      else conflicts += 1;
    }
    return { calls, conflicts };
  }
}
