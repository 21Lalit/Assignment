import type {
  Agent,
  AgentState,
  CallState,
  DialerCall,
  EventReductionResult,
  ProviderEvent,
} from './types';

export const TERMINAL_CALL_STATES = new Set<CallState>(['COMPLETED', 'FAILED', 'CANCELLED']);

export const CALL_STATE_ORDER: Readonly<Record<CallState, number>> = {
  QUEUED: 0,
  RESERVED: 1,
  INITIATED: 2,
  RINGING: 3,
  ANSWERED: 4,
  CONNECTED: 5,
  COMPLETED: 6,
  FAILED: 6,
  CANCELLED: 6,
};

export const AGENT_TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  OFFLINE: ['AVAILABLE', 'PAUSED'],
  AVAILABLE: ['RESERVED', 'PAUSED', 'OFFLINE'],
  RESERVED: ['DIALING', 'AVAILABLE', 'PAUSED', 'OFFLINE'],
  DIALING: ['CONNECTED', 'AVAILABLE', 'PAUSED', 'OFFLINE'],
  CONNECTED: ['WRAP_UP', 'OFFLINE'],
  WRAP_UP: ['AVAILABLE', 'PAUSED', 'OFFLINE'],
  PAUSED: ['AVAILABLE', 'OFFLINE'],
};

export function isTerminalCallState(state: CallState): boolean {
  return TERMINAL_CALL_STATES.has(state);
}

export function canTransitionAgent(from: AgentState, to: AgentState): boolean {
  return from === to || AGENT_TRANSITIONS[from].includes(to);
}

export function transitionAgent(agent: Agent, to: AgentState, now: number): boolean {
  if (agent.state === to) return false;
  if (!canTransitionAgent(agent.state, to)) {
    throw new Error(`Invalid agent transition ${agent.state} -> ${to} for ${agent.id}`);
  }
  agent.state = to;
  agent.stateSince = now;
  agent.version += 1;
  return true;
}

export function canAdvanceCall(from: CallState, to: CallState): boolean {
  if (from === to || isTerminalCallState(from)) return false;
  if (isTerminalCallState(to)) return true;
  return CALL_STATE_ORDER[to] > CALL_STATE_ORDER[from];
}

export function transitionCall(
  call: DialerCall,
  to: CallState,
  at: number,
  source: DialerCall['transitions'][number]['source'],
  options: { eventId?: string; reason?: string } = {},
): boolean {
  if (!canAdvanceCall(call.state, to)) return false;
  const from = call.state;
  call.state = to;
  call.stateSince = at;
  call.updatedAt = Math.max(call.updatedAt, at);
  call.version += 1;
  if (to === 'INITIATED') call.initiatedAt ??= at;
  if (to === 'ANSWERED') call.answeredAt ??= at;
  if (to === 'CONNECTED') call.connectedAt ??= at;
  if (to === 'COMPLETED') call.completedAt ??= at;
  if (to === 'FAILED' || to === 'CANCELLED') call.failureReason ??= options.reason;
  call.transitions.push({ from, to, at, source, ...options });
  return true;
}

const PROVIDER_STATE: Readonly<Record<ProviderEvent['type'], CallState>> = {
  INITIATED: 'INITIATED',
  RINGING: 'RINGING',
  ANSWERED: 'ANSWERED',
  CONNECTED: 'CONNECTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/**
 * Applies provider events exactly once while keeping the call lifecycle monotonic.
 * Event time is retained for audit, but arrival order can never rewind state.
 */
export class CallEventReducer {
  apply(call: DialerCall, event: ProviderEvent, receivedAt = event.receivedAt ?? event.occurredAt): EventReductionResult {
    const previousState = call.state;
    if (call.processedEventIds.has(event.id)) {
      return { outcome: 'DUPLICATE', previousState, state: call.state };
    }

    call.processedEventIds.add(event.id);
    const target = PROVIDER_STATE[event.type];
    if (!target) {
      return { outcome: 'UNKNOWN', previousState, state: call.state };
    }
    if (isTerminalCallState(call.state)) {
      return { outcome: 'TERMINAL_IGNORED', previousState, state: call.state };
    }
    if (target === 'CONNECTED' && !call.agentId) {
      return { outcome: 'OUT_OF_ORDER', previousState, state: call.state };
    }
    if (!canAdvanceCall(call.state, target)) {
      return { outcome: 'OUT_OF_ORDER', previousState, state: call.state };
    }

    // State observation is monotonic by receipt, while occurredAt remains meaningful
    // in the transition audit when it is not in the future.
    const transitionAt = Math.min(receivedAt, Math.max(event.occurredAt, call.stateSince));
    transitionCall(call, target, transitionAt, 'PROVIDER', {
      eventId: event.id,
      reason: event.reason,
    });
    return { outcome: 'APPLIED', previousState, state: call.state };
  }
}
