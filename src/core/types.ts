export const AGENT_STATES = [
  'OFFLINE',
  'AVAILABLE',
  'RESERVED',
  'DIALING',
  'CONNECTED',
  'WRAP_UP',
  'PAUSED',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const CALL_STATES = [
  'QUEUED',
  'RESERVED',
  'INITIATED',
  'RINGING',
  'ANSWERED',
  'CONNECTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type CallState = (typeof CALL_STATES)[number];
export type DialMode = 'PROGRESSIVE' | 'PREDICTIVE';
export type ProviderKind = 'RELIABLE' | 'CHAOS';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type ScenarioId =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'CRASH'
  | 'OUTAGE'
  | 'AGENT_DROP'
  | 'DUPLICATE_EVENTS'
  | 'OUT_OF_ORDER_EVENTS';

export interface Agent {
  id: string;
  state: AgentState;
  version: number;
  stateSince: number;
  reservedCallId?: string;
  leaseExpiresAt?: number;
  callsHandled: number;
}

export type BorrowerState = 'READY' | 'RESERVED' | 'IN_CALL' | 'DONE';

export interface Borrower {
  id: string;
  state: BorrowerState;
  version: number;
  priority: number;
  attempts: number;
  reservedCallId?: string;
  leaseExpiresAt?: number;
}

export interface DialerCall {
  id: string;
  borrowerId: string;
  agentId?: string;
  state: CallState;
  version: number;
  createdAt: number;
  updatedAt: number;
  stateSince: number;
  workerId: string;
  leaseExpiresAt: number;
  providerCallId?: string;
  providerKind?: ProviderKind;
  dialMode?: DialMode;
  initiatedAt?: number;
  answeredAt?: number;
  connectedAt?: number;
  completedAt?: number;
  failureReason?: string;
  recoveredCount: number;
  processedEventIds: Set<string>;
  transitions: CallTransition[];
}

export interface CallTransition {
  from: CallState;
  to: CallState;
  at: number;
  source: 'ALLOCATOR' | 'DIALER' | 'PROVIDER' | 'RECOVERY' | 'OPERATOR';
  eventId?: string;
  reason?: string;
}

export type ProviderEventType =
  | 'INITIATED'
  | 'RINGING'
  | 'ANSWERED'
  | 'CONNECTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface ProviderEvent {
  id: string;
  providerCallId: string;
  callId: string;
  type: ProviderEventType;
  occurredAt: number;
  receivedAt?: number;
  reason?: string;
}

export interface ScheduledProviderEvent extends ProviderEvent {
  dueAt: number;
  sequence: number;
}

export interface ProviderDialRequest {
  callId: string;
  borrowerId: string;
  agentId?: string;
  idempotencyKey: string;
  answerProbability: number;
  averageSetupMs: number;
  averageTalkMs: number;
}

export interface ProviderInitiation {
  accepted: boolean;
  providerCallId?: string;
  events: Omit<ScheduledProviderEvent, 'sequence'>[];
  latencyMs: number;
  error?: string;
  replayed?: boolean;
}

export interface ProviderStatus {
  kind: ProviderKind;
  name: string;
  circuitState: CircuitState;
  healthScore: number;
  recentSuccessRate: number;
  averageLatencyMs: number;
  consecutiveFailures: number;
  openUntil?: number;
  outageUntil?: number;
  requests: number;
  failures: number;
}

export interface PacingContext {
  mode: DialMode;
  now: number;
  availableAgents: number;
  reservedAgents: number;
  dialingAgents: number;
  connectedAgents: number;
  wrapUpAgents: number;
  readyBorrowers: number;
  queuedCalls: number;
  initiatedCalls: number;
  ringingCalls: number;
  answeredCalls: number;
  connectedCalls: number;
  providerInFlight: number;
  unassignedInFlightCalls: number;
  providerHeadroom: number;
  providerHealth: number;
  circuitState: CircuitState;
  ewmaAnswerRate: number;
  recentAnswerRate: number;
  historicalSamples: number;
  averageSetupMs: number;
  averageTalkMs: number;
  maxBatchSize: number;
  minAnswerRate: number;
  confidenceZ: number;
}

export interface PacingFactors {
  availableCapacity: number;
  releaseForecast: number;
  expectedAnswersInFlight: number;
  uncertaintyBuffer: number;
  effectiveAnswerRate: number;
  behaviorMultiplier: number;
  providerMultiplier: number;
  providerHeadroom: number;
}

export interface PaceProposal {
  mode: DialMode;
  requestedCalls: number;
  generatedAt: number;
  formula: string;
  explanation: string;
  factors: PacingFactors;
}

export type SafetyAction = 'APPROVE' | 'REDUCE' | 'REJECT' | 'FALLBACK_PROGRESSIVE';

export interface SafetyDecision {
  action: SafetyAction;
  requestedCalls: number;
  approvedCalls: number;
  hardCapacity: number;
  predictedAnswerUpperBound: number;
  safetyAnswerRate: number;
  reasonCode:
    | 'WITHIN_LIMITS'
    | 'HARD_CAPACITY'
    | 'NO_CAPACITY'
    | 'CIRCUIT_OPEN'
    | 'PROVIDER_DEGRADED'
    | 'INSUFFICIENT_HISTORY'
    | 'NO_REQUEST';
  explanation: string;
  decidedAt: number;
  invariant: string;
}

export interface SafetyConfig {
  minProviderHealth: number;
  minHistoricalSamples: number;
  progressiveFallbackBatch: number;
  maxProviderInFlight: number;
  deterministicReservation: boolean;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  windowSize: number;
  openDurationMs: number;
  halfOpenSuccesses: number;
}

export interface ChaosProviderConfig {
  timeoutRate: number;
  failureRate: number;
  duplicateRate: number;
  outOfOrderRate: number;
  minimumLatencyMs: number;
  maximumLatencyMs: number;
}

export interface SimulatorConfig {
  mode: DialMode;
  provider: ProviderKind;
  scenario?: ScenarioId;
  seed: number | string;
  agentCount: number;
  borrowerCount: number;
  workerCount: number;
  tickMs: number;
  leaseMs: number;
  wrapUpMs: number;
  answerRate: number;
  averageSetupMs: number;
  averageTalkMs: number;
  ewmaAlpha: number;
  initialHistoricalSamples: number;
  maxBatchSize: number;
  minAnswerRate: number;
  confidenceZ: number;
  timelineLimit: number;
  safety: SafetyConfig;
  circuitBreaker: CircuitBreakerConfig;
  chaosProvider: ChaosProviderConfig;
}

export type SimulatorConfigInput = Partial<Omit<SimulatorConfig, 'safety' | 'circuitBreaker' | 'chaosProvider'>> & {
  safety?: Partial<SafetyConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  chaosProvider?: Partial<ChaosProviderConfig>;
};

export interface DialerMetrics {
  reservations: number;
  casConflicts: number;
  callsInitiated: number;
  callsAnswered: number;
  callsConnected: number;
  callsCompleted: number;
  callsFailed: number;
  callsCancelled: number;
  providerRequests: number;
  providerFailures: number;
  duplicateEventsIgnored: number;
  outOfOrderEventsIgnored: number;
  terminalEventsIgnored: number;
  unknownEventsIgnored: number;
  unservedAnswers: number;
  safetyBreaches: number;
  leasesRecovered: number;
  workerCrashes: number;
  safetyApprovals: number;
  safetyReductions: number;
  safetyRejections: number;
  safetyFallbacks: number;
  peakProviderInFlight: number;
  connectedAgentMs: number;
  availableAgentMs: number;
  totalAgentMs: number;
}

export interface TimelineEntry {
  id: number;
  at: number;
  category: 'PACING' | 'SAFETY' | 'CALL' | 'AGENT' | 'PROVIDER' | 'RECOVERY' | 'SYSTEM';
  severity: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  message: string;
  callId?: string;
  agentId?: string;
}

export interface WorkerSnapshot {
  id: string;
  active: boolean;
  crashedAt?: number;
  recoverAt?: number;
  ownedCalls: number;
}

export interface CallSnapshot extends Omit<DialerCall, 'processedEventIds' | 'transitions'> {
  processedEventCount: number;
  transitions: CallTransition[];
}

export interface DialerRates {
  agentUtilization: number;
  ewmaAnswerRate: number;
  recentAnswerRate: number;
  observedAnswerRate: number;
  providerSuccessRate: number;
  completionRate: number;
  callsPerMinute: number;
}

export interface InvariantSnapshot {
  safe: boolean;
  violations: string[];
  activeAgentReservations: number;
  activeBorrowerReservations: number;
  duplicateAgentReservations: number;
  duplicateBorrowerReservations: number;
  unboundActiveCalls: number;
  progressiveExposure: number;
  unservedAnswers: number;
  safetyBreaches: number;
  statement: string;
}

export interface SimulatorSnapshot {
  now: number;
  elapsedMs: number;
  mode: DialMode;
  scenario?: ScenarioId;
  running: boolean;
  config: SimulatorConfig;
  agents: Agent[];
  agentCounts: Record<AgentState, number>;
  borrowers: Borrower[];
  borrowerCounts: Record<BorrowerState, number>;
  calls: CallSnapshot[];
  callCounts: Record<CallState, number>;
  workers: WorkerSnapshot[];
  metrics: DialerMetrics;
  rates: DialerRates;
  pacing: PaceProposal;
  safety: SafetyDecision;
  provider: ProviderStatus;
  timeline: TimelineEntry[];
  trends: TrendPoint[];
  invariants: InvariantSnapshot;
  queueDepth: number;
  nextProviderEvents: number;
}

export type SimulatorCommand =
  | { type: 'SET_MODE'; mode: DialMode }
  | { type: 'SET_AGENT_STATE'; agentId: string; state: AgentState }
  | { type: 'AGENT_DROP'; count: number }
  | { type: 'WORKER_CRASH'; workerId?: string; recoverAfterMs?: number }
  | { type: 'WORKER_RECOVER'; workerId?: string }
  | { type: 'PROVIDER_OUTAGE'; durationMs: number }
  | { type: 'PROVIDER_LATENCY'; latencyMs: number; durationMs?: number }
  | { type: 'ANSWER_SPIKE'; answerRate: number; durationMs: number }
  | { type: 'WEBHOOK_LOSS'; lossRate: number; durationMs: number }
  | { type: 'PROVIDER_EVENT'; event: ProviderEvent }
  | { type: 'ENQUEUE_BORROWERS'; count: number }
  | {
      type: 'SET_CONDITIONS';
      answerRate?: number;
      averageSetupMs?: number;
      averageTalkMs?: number;
      provider?: ProviderKind;
    }
  | { type: 'SCENARIO'; scenario: ScenarioId };

export interface ReservationRequest {
  borrowerId: string;
  agentId: string;
  workerId: string;
  now: number;
  leaseMs: number;
  expectedBorrowerVersion?: number;
  expectedAgentVersion?: number;
}

export interface ReservationResult {
  ok: boolean;
  call?: DialerCall;
  reason?: 'AGENT_NOT_AVAILABLE' | 'BORROWER_NOT_READY' | 'AGENT_VERSION_CONFLICT' | 'BORROWER_VERSION_CONFLICT';
}

export interface AgentAssignmentResult {
  ok: boolean;
  call?: DialerCall;
  reason?: 'CALL_NOT_ASSIGNABLE' | 'CALL_VERSION_CONFLICT' | 'AGENT_NOT_AVAILABLE' | 'AGENT_VERSION_CONFLICT';
}

export interface TrendPoint {
  at: number;
  availableAgents: number;
  connectedAgents: number;
  ringingCalls: number;
  callsInitiated: number;
  callsConnected: number;
  utilization: number;
  ewmaAnswerRate: number;
  providerHealth: number;
  requested: number;
  approved: number;
  safetyBreaches: number;
}

export interface BatchReservationResult {
  calls: DialerCall[];
  conflicts: number;
}

export interface EventReductionResult {
  outcome: 'APPLIED' | 'DUPLICATE' | 'OUT_OF_ORDER' | 'TERMINAL_IGNORED' | 'UNKNOWN';
  previousState: CallState;
  state: CallState;
}

export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  description: string;
  config: SimulatorConfigInput;
  setup?: SimulatorCommand[];
}
