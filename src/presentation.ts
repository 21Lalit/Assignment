import type {
  AgentState,
  CallState,
  SimulatorSnapshot,
  TimelineEntry,
} from './core';
import type {
  AuditEvent,
  DashboardViewModel,
  FailureControl,
  FailureId,
  HealthStatus,
  ScenarioId,
  ScenarioPreset,
  Severity,
  SimulationStatus,
  StateDatum,
  TrendPoint,
} from './ui';

export const DASHBOARD_SCENARIOS: ScenarioPreset[] = [
  {
    id: 'a',
    shortLabel: 'A',
    title: 'Low answer rate',
    description: '20% answer rate · 120s talk time',
    answerRate: 20,
    averageHandleTimeSeconds: 120,
  },
  {
    id: 'b',
    shortLabel: 'B',
    title: 'Balanced campaign',
    description: '50% answer rate · 90s talk time',
    answerRate: 50,
    averageHandleTimeSeconds: 90,
  },
  {
    id: 'c',
    shortLabel: 'C',
    title: 'High answer rate',
    description: '70% answer rate · 180s talk time',
    answerRate: 70,
    averageHandleTimeSeconds: 180,
  },
  {
    id: 'd',
    shortLabel: 'D',
    title: 'Changing behaviour',
    description: 'Answer rate, duration and provider health shift during the run',
    tone: 'warning',
  },
  {
    id: 'outage',
    shortLabel: '05',
    title: 'Provider outage',
    description: 'Timeout burst opens the circuit and forces a guarded recovery',
    tone: 'critical',
  },
  {
    id: 'agent-drop',
    shortLabel: '06',
    title: 'Agent cliff',
    description: '40 of 100 available agents disappear in one decision window',
    tone: 'critical',
  },
  {
    id: 'chaos',
    shortLabel: '07',
    title: 'Webhook chaos',
    description: 'Duplicate and reordered provider events exercise idempotency',
    tone: 'warning',
  },
];

const AGENT_COLORS: Record<AgentState, string> = {
  OFFLINE: '#98A2B3',
  AVAILABLE: '#169B6B',
  RESERVED: '#FCAF17',
  DIALING: '#F15A22',
  CONNECTED: '#2878D0',
  WRAP_UP: '#7A5AF8',
  PAUSED: '#667085',
};

const CALL_COLORS: Record<CallState, string> = {
  QUEUED: '#98A2B3',
  RESERVED: '#FCAF17',
  INITIATED: '#F79009',
  RINGING: '#F15A22',
  ANSWERED: '#12B76A',
  CONNECTED: '#2878D0',
  COMPLETED: '#169B6B',
  FAILED: '#D92D20',
  CANCELLED: '#667085',
};

export const SCENARIO_TO_CORE = {
  a: 'A',
  b: 'B',
  c: 'C',
  d: 'D',
  outage: 'OUTAGE',
  'agent-drop': 'AGENT_DROP',
  chaos: 'OUT_OF_ORDER_EVENTS',
} as const;

export interface PresentationOptions {
  status: SimulationStatus;
  selectedScenarioId: ScenarioId;
  activeFailures: ReadonlySet<FailureId>;
  runSequence: number;
}

export function toDashboardViewModel(
  snapshot: SimulatorSnapshot,
  options: PresentationOptions,
): DashboardViewModel {
  const tickRate = 60_000 / Math.max(1, snapshot.config.tickMs);
  const activeCalls =
    snapshot.callCounts.RESERVED +
    snapshot.callCounts.INITIATED +
    snapshot.callCounts.RINGING +
    snapshot.callCounts.ANSWERED +
    snapshot.callCounts.CONNECTED;
  const providerStatus = healthStatus(snapshot.provider.healthScore, snapshot.provider.circuitState);
  const safetyState =
    snapshot.metrics.safetyBreaches > 0 || snapshot.provider.circuitState === 'OPEN'
      ? 'halted'
      : snapshot.safety.action === 'REDUCE' || snapshot.safety.action === 'FALLBACK_PROGRESSIVE'
        ? 'constrained'
        : 'safe';

  return {
    status: options.status,
    mode: snapshot.mode === 'PROGRESSIVE' ? 'progressive' : 'predictive',
    selectedScenarioId: options.selectedScenarioId,
    scenarios: DASHBOARD_SCENARIOS,
    elapsedTime: formatDuration(snapshot.elapsedMs),
    simulationClock: `T+${formatDuration(snapshot.elapsedMs)}`,
    nextDecisionIn: options.status === 'running' ? `${(snapshot.config.tickMs / 1_000).toFixed(1)}s` : 'manual',
    metrics: [
      {
        id: 'utilization',
        label: 'Agent utilization',
        value: formatPercent(snapshot.rates.agentUtilization),
        detail: `${snapshot.agentCounts.CONNECTED} connected · ${snapshot.agentCounts.AVAILABLE} available`,
        tone: snapshot.rates.agentUtilization >= 0.7 ? 'positive' : 'neutral',
        icon: 'agents',
      },
      {
        id: 'initiated',
        label: 'Calls initiated',
        value: snapshot.metrics.callsInitiated.toLocaleString(),
        detail: `${snapshot.nextProviderEvents} provider events scheduled`,
        icon: 'calls',
      },
      {
        id: 'connected',
        label: 'Calls connected',
        value: snapshot.metrics.callsConnected.toLocaleString(),
        detail: `${formatPercent(snapshot.rates.completionRate)} completion rate`,
        tone: 'positive',
        icon: 'answer',
      },
      {
        id: 'answer-rate',
        label: 'Observed answer rate',
        value: formatPercent(snapshot.rates.observedAnswerRate),
        detail: `EWMA ${formatPercent(snapshot.rates.ewmaAnswerRate)} · model adapts each answer`,
        icon: 'target',
      },
      {
        id: 'safety',
        label: 'Safety breaches',
        value: snapshot.metrics.safetyBreaches.toLocaleString(),
        detail: snapshot.invariants.safe ? 'All live invariants hold' : snapshot.invariants.violations[0] ?? 'Review required',
        tone: snapshot.metrics.safetyBreaches === 0 ? 'positive' : 'critical',
        icon: 'shield',
      },
      {
        id: 'provider',
        label: 'Provider health',
        value: formatPercent(snapshot.provider.healthScore),
        detail: `${Math.round(snapshot.provider.averageLatencyMs)}ms average · ${snapshot.provider.circuitState.toLowerCase()} circuit`,
        tone: providerStatus === 'healthy' ? 'positive' : providerStatus === 'degraded' ? 'warning' : 'critical',
        icon: 'latency',
      },
    ],
    safetyDecision: {
      state: safetyState,
      headline:
        safetyState === 'halted'
          ? 'New dialing is contained'
          : safetyState === 'constrained'
            ? 'Demand reduced to the safe envelope'
            : 'Pacing is inside every guardrail',
      explanation: snapshot.safety.explanation,
      requestedCallsPerMinute: Math.round(snapshot.pacing.requestedCalls * tickRate),
      approvedCallsPerMinute: Math.round(snapshot.safety.approvedCalls * tickRate),
      safeCeilingCallsPerMinute: Math.round(snapshot.safety.hardCapacity * tickRate),
      confidencePercent: zToConfidence(snapshot.config.confidenceZ),
      limitingFactor: humanize(snapshot.safety.reasonCode),
      guardrail: snapshot.safety.invariant,
      inputs: [
        {
          label: 'Available capacity',
          value: snapshot.pacing.factors.availableCapacity.toLocaleString(),
          detail: 'Agents eligible for atomic assignment',
          tone: snapshot.pacing.factors.availableCapacity > 0 ? 'positive' : 'critical',
        },
        {
          label: 'EWMA answer rate',
          value: formatPercent(snapshot.pacing.factors.effectiveAnswerRate),
          detail: 'Bounded by the configured minimum',
        },
        {
          label: 'In-flight answers',
          value: snapshot.pacing.factors.expectedAnswersInFlight.toFixed(1),
          detail: `Upper bound ${snapshot.safety.predictedAnswerUpperBound.toFixed(1)}`,
          tone: 'warning',
        },
        {
          label: 'Uncertainty buffer',
          value: snapshot.pacing.factors.uncertaintyBuffer.toFixed(1),
          detail: `z=${snapshot.config.confidenceZ.toFixed(2)}`,
        },
        {
          label: 'Provider multiplier',
          value: formatPercent(snapshot.pacing.factors.providerMultiplier),
          detail: `${snapshot.provider.circuitState} circuit`,
          tone: providerStatus === 'healthy' ? 'positive' : 'warning',
        },
      ],
    },
    trend: mapTrends(snapshot),
    agentStates: mapAgentStates(snapshot),
    callStates: mapCallStates(snapshot),
    providers: [
      {
        id: snapshot.provider.kind.toLowerCase(),
        name: snapshot.provider.name,
        status: providerStatus,
        route: 'Active route',
        latencyMs: Math.round(snapshot.provider.averageLatencyMs),
        successRatePercent: Math.round(snapshot.provider.recentSuccessRate * 100),
        activeCalls,
        detail: `${snapshot.provider.requests} requests · ${snapshot.provider.failures} provider failures`,
      },
      {
        id: snapshot.provider.kind === 'RELIABLE' ? 'chaos-standby' : 'reliable-standby',
        name: snapshot.provider.kind === 'RELIABLE' ? 'Drishti Chaos Voice' : 'Saarthi Reliable Voice',
        status: 'healthy',
        route: 'Standby mock',
        latencyMs: snapshot.provider.kind === 'RELIABLE' ? 740 : 160,
        successRatePercent: snapshot.provider.kind === 'RELIABLE' ? 91 : 100,
        activeCalls: 0,
        detail: 'Provider interface is interchangeable; no dialer internals leak through.',
      },
    ],
    events: snapshot.timeline.slice(-16).reverse().map(mapEvent),
    pipeline: [
      {
        id: 'pacing',
        label: `${humanize(snapshot.mode)} pacing`,
        eyebrow: 'Advisory demand',
        detail: snapshot.pacing.formula,
        metric: `${snapshot.pacing.requestedCalls} requested`,
        status: options.status === 'running' ? 'active' : 'complete',
      },
      {
        id: 'safety',
        label: 'Safety controller',
        eyebrow: 'Non-bypassable gate',
        detail: snapshot.safety.explanation,
        metric: `${snapshot.safety.approvedCalls} approved`,
        status: snapshot.safety.approvedCalls > 0 ? 'guarded' : 'waiting',
      },
      {
        id: 'allocator',
        label: 'Call allocator',
        eyebrow: 'Atomic reservation',
        detail: `${snapshot.metrics.casConflicts} CAS conflicts; no duplicate ownership`,
        metric: `${snapshot.metrics.reservations} leases`,
        status: snapshot.metrics.reservations > 0 ? 'complete' : 'waiting',
      },
      {
        id: 'provider',
        label: 'Telecom provider',
        eyebrow: 'Idempotent boundary',
        detail: `${snapshot.metrics.duplicateEventsIgnored} duplicates and ${snapshot.metrics.outOfOrderEventsIgnored} stale events ignored`,
        metric: snapshot.provider.circuitState,
        status: snapshot.provider.circuitState === 'OPEN' ? 'waiting' : options.status === 'running' ? 'active' : 'complete',
      },
    ],
    failures: failureControls(options.activeFailures),
    runSequence: options.runSequence,
    lastUpdatedLabel: snapshot.invariants.safe ? 'All invariants green' : `${snapshot.invariants.violations.length} invariant alert(s)`,
  };
}

function mapTrends(snapshot: SimulatorSnapshot): TrendPoint[] {
  const multiplier = 60_000 / Math.max(1, snapshot.config.tickMs);
  return snapshot.trends.slice(-28).map((point, index, points) => {
    const previous = points[index - 1];
    const elapsed = previous ? Math.max(1, point.at - previous.at) : snapshot.config.tickMs;
    const connectedDelta = previous ? Math.max(0, point.callsConnected - previous.callsConnected) : 0;
    return {
      label: `T+${formatDuration(point.at)}`,
      dialRate: Math.round(point.requested * multiplier),
      safeRate: Math.round(point.approved * multiplier),
      connected: Math.round(connectedDelta * (60_000 / elapsed)),
    };
  });
}

function mapAgentStates(snapshot: SimulatorSnapshot): StateDatum[] {
  return Object.entries(snapshot.agentCounts)
    .filter(([, value]) => value > 0)
    .map(([state, value]) => ({
      id: state,
      label: humanize(state),
      value,
      displayValue: value.toLocaleString(),
      color: AGENT_COLORS[state as AgentState],
    }));
}

function mapCallStates(snapshot: SimulatorSnapshot): StateDatum[] {
  return Object.entries(snapshot.callCounts)
    .filter(([, value]) => value > 0)
    .map(([state, value]) => ({
      id: state,
      label: humanize(state),
      value,
      displayValue: value.toLocaleString(),
      color: CALL_COLORS[state as CallState],
    }));
}

function failureControls(active: ReadonlySet<FailureId>): FailureControl[] {
  const controls: Array<Omit<FailureControl, 'active'>> = [
    { id: 'provider-latency', label: 'Latency spike', description: 'Add 3.5s provider setup latency', severity: 'medium' },
    { id: 'provider-outage', label: 'Provider outage', description: 'Timeout new requests and open the circuit', severity: 'high' },
    { id: 'agent-drop', label: 'Agent cliff', description: 'Take 40 available agents offline at once', severity: 'high' },
    { id: 'answer-spike', label: 'Answer spike', description: 'Raise the true answer rate to 90%', severity: 'high' },
    { id: 'webhook-loss', label: 'Webhook loss', description: 'Drop half of provider callbacks temporarily', severity: 'medium' },
    { id: 'worker-crash', label: 'Worker crash', description: 'Crash one allocator after call initiation', severity: 'high' },
    { id: 'duplicate-events', label: 'Duplicate events', description: 'Replay provider events with the same identity', severity: 'medium' },
    { id: 'event-reordering', label: 'Event reordering', description: 'Deliver completion before earlier call events', severity: 'high' },
  ];
  return controls.map((control) => ({ ...control, active: active.has(control.id) }));
}

function mapEvent(entry: TimelineEntry): AuditEvent {
  const severity: Severity =
    entry.severity === 'ERROR'
      ? 'critical'
      : entry.severity === 'WARN'
        ? 'warning'
        : entry.severity === 'SUCCESS'
          ? 'success'
          : 'info';
  return {
    id: String(entry.id),
    timestamp: `T+${formatDuration(entry.at)}`,
    severity,
    source: humanize(entry.category),
    title: entry.message,
    detail: [entry.callId, entry.agentId].filter(Boolean).join(' · ') || 'Decision recorded in the append-only audit timeline.',
    decisionId: entry.category === 'SAFETY' ? `SAFE-${entry.id}` : undefined,
  };
}

function healthStatus(score: number, circuit: string): HealthStatus {
  if (circuit === 'OPEN' || score < 0.45) return 'down';
  if (circuit === 'HALF_OPEN' || score < 0.8) return 'degraded';
  return 'healthy';
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function zToConfidence(z: number): number {
  const absolute = Math.abs(z);
  const erfApproximation = Math.sqrt(1 - Math.exp((-2 * absolute * absolute) / Math.PI));
  return Math.min(99.9, Math.max(50, 50 * (1 + erfApproximation)));
}
