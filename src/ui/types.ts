export type DialerMode = 'progressive' | 'predictive';

export type SimulationStatus = 'idle' | 'running' | 'paused' | 'complete';

export type ScenarioId =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'outage'
  | 'agent-drop'
  | 'chaos';

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export type Severity = 'info' | 'success' | 'warning' | 'critical';

export type PipelineStatus = 'complete' | 'active' | 'guarded' | 'waiting';

export type FailureId =
  | 'provider-latency'
  | 'provider-outage'
  | 'agent-drop'
  | 'answer-spike'
  | 'webhook-loss'
  | 'worker-crash'
  | 'duplicate-events'
  | 'event-reordering';

export interface ScenarioPreset {
  id: ScenarioId;
  shortLabel: string;
  title: string;
  description: string;
  answerRate?: number;
  averageHandleTimeSeconds?: number;
  tone?: 'standard' | 'warning' | 'critical';
}

export interface MetricDatum {
  id: string;
  label: string;
  value: string;
  detail: string;
  trend?: number;
  trendLabel?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'critical';
  icon?: 'calls' | 'agents' | 'target' | 'answer' | 'shield' | 'latency';
}

export interface SafetyDecision {
  state: 'safe' | 'constrained' | 'halted';
  headline: string;
  explanation: string;
  requestedCallsPerMinute: number;
  approvedCallsPerMinute: number;
  safeCeilingCallsPerMinute: number;
  confidencePercent: number;
  limitingFactor: string;
  guardrail: string;
  inputs: Array<{
    label: string;
    value: string;
    detail?: string;
    tone?: 'neutral' | 'positive' | 'warning' | 'critical';
  }>;
}

export interface TrendPoint {
  label: string;
  dialRate: number;
  safeRate: number;
  connected: number;
}

export interface StateDatum {
  id: string;
  label: string;
  value: number;
  displayValue?: string;
  color: string;
}

export interface ProviderHealth {
  id: string;
  name: string;
  status: HealthStatus;
  route: string;
  latencyMs: number;
  successRatePercent: number;
  activeCalls: number;
  detail: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  severity: Severity;
  source: string;
  title: string;
  detail: string;
  decisionId?: string;
}

export interface PipelineStage {
  id: 'pacing' | 'safety' | 'allocator' | 'provider';
  label: string;
  eyebrow: string;
  detail: string;
  metric: string;
  status: PipelineStatus;
}

export interface FailureControl {
  id: FailureId;
  label: string;
  description: string;
  active: boolean;
  severity: 'medium' | 'high';
}

export interface DashboardViewModel {
  status: SimulationStatus;
  mode: DialerMode;
  selectedScenarioId: ScenarioId;
  scenarios: ScenarioPreset[];
  elapsedTime: string;
  simulationClock: string;
  nextDecisionIn: string;
  metrics: MetricDatum[];
  safetyDecision: SafetyDecision;
  trend: TrendPoint[];
  agentStates: StateDatum[];
  callStates: StateDatum[];
  providers: ProviderHealth[];
  events: AuditEvent[];
  pipeline: PipelineStage[];
  failures: FailureControl[];
  runSequence?: number;
  lastUpdatedLabel?: string;
}

export interface DashboardActions {
  onModeChange?: (mode: DialerMode) => void;
  onScenarioSelect?: (scenarioId: ScenarioId) => void;
  onRun?: () => void;
  onPause?: () => void;
  onStep?: () => void;
  onReset?: () => void;
  onFailureToggle?: (failureId: FailureId, active: boolean) => void;
}

export interface DashboardProps extends DashboardActions {
  viewModel: DashboardViewModel;
  className?: string;
}
