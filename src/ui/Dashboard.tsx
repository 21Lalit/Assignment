import { useId, type CSSProperties, type ReactNode } from 'react';
import { BrandLoop, Icon, type IconName } from './icons';
import type {
  AuditEvent,
  DashboardProps,
  DialerMode,
  FailureControl,
  HealthStatus,
  MetricDatum,
  PipelineStage,
  ProviderHealth as ProviderHealthDatum,
  SafetyDecision,
  ScenarioId,
  ScenarioPreset,
  SimulationStatus,
  StateDatum,
  TrendPoint,
} from './types';
import '../styles.css';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

interface SectionHeadingProps {
  eyebrow: string;
  title: string;
  titleId?: string;
  description?: string;
  action?: ReactNode;
}

function SectionHeading({ eyebrow, title, titleId, description, action }: SectionHeadingProps) {
  return (
    <div className="section-heading">
      <div>
        <span className="section-heading__eyebrow">{eyebrow}</span>
        <h2 id={titleId}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="section-heading__action">{action}</div> : null}
    </div>
  );
}

interface HeaderProps {
  status: SimulationStatus;
  elapsedTime: string;
  lastUpdatedLabel?: string;
}

export function DashboardHeader({ status, elapsedTime, lastUpdatedLabel }: HeaderProps) {
  const stateLabel = status === 'running' ? 'Live simulation' : status === 'paused' ? 'Simulation paused' : status === 'complete' ? 'Run complete' : 'Ready to simulate';

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <a className="brand" href="#main-content" aria-label="CredResolve SmartDialer home">
          <span className="brand__mark"><BrandLoop /></span>
          <span className="brand__words">
            <strong>CredResolve</strong>
            <small>SmartDialer</small>
          </span>
        </a>

        <div className="header-context" aria-label="Application context">
          <span className="header-context__slash" aria-hidden="true" />
          <span>
            <small>Recovery operations</small>
            <strong>Decision control room</strong>
          </span>
        </div>

        <div className="header-status">
          <div className="header-status__meta">
            <span>{lastUpdatedLabel ?? `Elapsed ${elapsedTime}`}</span>
            <strong>{stateLabel}</strong>
          </div>
          <div className="safety-live" role="status" aria-live="polite">
            <span className="safety-live__pulse" aria-hidden="true" />
            <Icon name="shield" size={16} />
            <span>Safety enforced</span>
          </div>
        </div>
      </div>
    </header>
  );
}

interface ModeTabsProps {
  mode: DialerMode;
  onModeChange?: (mode: DialerMode) => void;
}

export function ModeTabs({ mode, onModeChange }: ModeTabsProps) {
  const modes: Array<{ id: DialerMode; label: string; detail: string }> = [
    { id: 'progressive', label: 'Progressive', detail: 'One call per available agent' },
    { id: 'predictive', label: 'Predictive', detail: 'Safety-capped forecast pacing' },
  ];

  return (
    <div className="mode-picker" role="tablist" aria-label="Dialer mode">
      {modes.map((item) => (
        <button
          className={cx('mode-tab', mode === item.id && 'is-active')}
          key={item.id}
          type="button"
          role="tab"
          aria-selected={mode === item.id}
          onClick={() => onModeChange?.(item.id)}
        >
          <span className="mode-tab__radio" aria-hidden="true" />
          <span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

interface ScenarioPickerProps {
  scenarios: ScenarioPreset[];
  selectedId: ScenarioId;
  onSelect?: (scenarioId: ScenarioId) => void;
}

function ScenarioBadge({ scenario }: { scenario: ScenarioPreset }) {
  if (typeof scenario.answerRate === 'number') {
    return (
      <span className="scenario-card__figures">
        <strong>{scenario.answerRate}%</strong>
        <span>answer</span>
        <i aria-hidden="true" />
        <strong>{scenario.averageHandleTimeSeconds}s</strong>
        <span>AHT</span>
      </span>
    );
  }

  const icon: IconName = scenario.id === 'outage' ? 'cloud' : scenario.id === 'agent-drop' ? 'agents' : 'spark';
  return (
    <span className="scenario-card__fault">
      <Icon name={icon} size={17} />
      <span>{scenario.id === 'd' ? 'Rate shifts' : scenario.id === 'chaos' ? 'Multi-fault' : 'Fault test'}</span>
    </span>
  );
}

export function ScenarioPicker({ scenarios, selectedId, onSelect }: ScenarioPickerProps) {
  return (
    <div className="scenario-scroll" role="group" aria-label="Scenario presets">
      {scenarios.map((scenario) => (
        <button
          type="button"
          key={scenario.id}
          className={cx(
            'scenario-card',
            `scenario-card--${scenario.tone ?? 'standard'}`,
            selectedId === scenario.id && 'is-selected',
          )}
          aria-pressed={selectedId === scenario.id}
          title={scenario.description}
          onClick={() => onSelect?.(scenario.id)}
        >
          <span className="scenario-card__topline">
            <strong>{scenario.shortLabel}</strong>
            <span>{scenario.title}</span>
            {selectedId === scenario.id ? <Icon name="check" size={14} /> : null}
          </span>
          <ScenarioBadge scenario={scenario} />
        </button>
      ))}
    </div>
  );
}

interface RunControlsProps {
  status: SimulationStatus;
  simulationClock: string;
  nextDecisionIn: string;
  onRun?: () => void;
  onPause?: () => void;
  onStep?: () => void;
  onReset?: () => void;
}

export function RunControls({
  status,
  simulationClock,
  nextDecisionIn,
  onRun,
  onPause,
  onStep,
  onReset,
}: RunControlsProps) {
  return (
    <div className="run-controls">
      <div className="sim-clock" aria-label={`Simulation clock ${simulationClock}`}>
        <Icon name="clock" size={18} />
        <span>
          <small>Simulation time</small>
          <strong>{simulationClock}</strong>
        </span>
        <span className="sim-clock__next">Decision in {nextDecisionIn}</span>
      </div>
      <div className="button-cluster" aria-label="Simulation controls">
        <button className="control-button control-button--run" type="button" onClick={onRun} disabled={status === 'running'}>
          <Icon name="play" size={16} />
          Run
        </button>
        <button className="control-button" type="button" onClick={onPause} disabled={status !== 'running'}>
          <Icon name="pause" size={16} />
          Pause
        </button>
        <button className="control-button" type="button" onClick={onStep} disabled={status === 'running'}>
          <Icon name="step" size={16} />
          Step
        </button>
        <button className="control-button control-button--quiet" type="button" onClick={onReset}>
          <Icon name="reset" size={16} />
          Reset
        </button>
      </div>
    </div>
  );
}

interface ControlDeckProps {
  mode: DialerMode;
  scenarios: ScenarioPreset[];
  selectedScenarioId: ScenarioId;
  status: SimulationStatus;
  simulationClock: string;
  nextDecisionIn: string;
  onModeChange?: (mode: DialerMode) => void;
  onScenarioSelect?: (scenarioId: ScenarioId) => void;
  onRun?: () => void;
  onPause?: () => void;
  onStep?: () => void;
  onReset?: () => void;
}

export function ControlDeck(props: ControlDeckProps) {
  return (
    <section className="control-deck" aria-labelledby="control-deck-title">
      <div className="control-deck__intro">
        <div>
          <span className="hero-kicker"><Icon name="spark" size={14} /> AI-powered recovery orchestration</span>
          <h1 id="control-deck-title">SmartDialer operations</h1>
          <p>Observe every pacing decision, test operational shocks, and keep customer conversations within safe limits.</p>
        </div>
        <ModeTabs mode={props.mode} onModeChange={props.onModeChange} />
      </div>
      <div className="control-deck__scenario-label">
        <span>Scenario presets</span>
        <span>Choose a workload or inject a resilience test</span>
      </div>
      <ScenarioPicker scenarios={props.scenarios} selectedId={props.selectedScenarioId} onSelect={props.onScenarioSelect} />
      <RunControls
        status={props.status}
        simulationClock={props.simulationClock}
        nextDecisionIn={props.nextDecisionIn}
        onRun={props.onRun}
        onPause={props.onPause}
        onStep={props.onStep}
        onReset={props.onReset}
      />
    </section>
  );
}

const metricIcons: Record<NonNullable<MetricDatum['icon']>, IconName> = {
  calls: 'calls',
  agents: 'agents',
  target: 'target',
  answer: 'answer',
  shield: 'shield',
  latency: 'latency',
};

export function MetricGrid({ metrics }: { metrics: MetricDatum[] }) {
  return (
    <section className="metric-grid" aria-label="Key operations metrics">
      {metrics.map((metric) => {
        const trendDirection = typeof metric.trend === 'number' && metric.trend < 0 ? 'down' : 'up';
        return (
          <article className={cx('metric-card', `metric-card--${metric.tone ?? 'neutral'}`)} key={metric.id}>
            <div className="metric-card__top">
              <span>{metric.label}</span>
              <span className="metric-card__icon"><Icon name={metric.icon ? metricIcons[metric.icon] : 'activity'} size={17} /></span>
            </div>
            <div className="metric-card__value">{metric.value}</div>
            <div className="metric-card__footer">
              {typeof metric.trend === 'number' ? (
                <span className={cx('metric-trend', `metric-trend--${trendDirection}`)}>
                  <Icon name={trendDirection === 'down' ? 'arrow-down' : 'arrow-up'} size={12} />
                  {Math.abs(metric.trend).toFixed(1)}%
                </span>
              ) : null}
              <span>{metric.trendLabel ?? metric.detail}</span>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function DecisionState({ state }: { state: SafetyDecision['state'] }) {
  const content = {
    safe: { label: 'Within guardrails', icon: 'check' as IconName },
    constrained: { label: 'Safety constrained', icon: 'shield' as IconName },
    halted: { label: 'Dialing halted', icon: 'warning' as IconName },
  }[state];

  return (
    <span className={cx('decision-state', `decision-state--${state}`)}>
      <Icon name={content.icon} size={14} />
      {content.label}
    </span>
  );
}

export function SafetyController({ decision }: { decision: SafetyDecision }) {
  const chartMaximum = Math.max(
    decision.requestedCallsPerMinute,
    decision.approvedCallsPerMinute,
    decision.safeCeilingCallsPerMinute,
    1,
  );
  const approvedWidth = clamp((decision.approvedCallsPerMinute / chartMaximum) * 100);
  const requestedWidth = clamp((decision.requestedCallsPerMinute / chartMaximum) * 100);
  const ceilingPosition = clamp((decision.safeCeilingCallsPerMinute / chartMaximum) * 100);

  return (
    <section className={cx('panel', 'safety-controller', `safety-controller--${decision.state}`)} aria-labelledby="safety-title">
      <div className="safety-controller__hero">
        <div className="safety-controller__orb" aria-hidden="true"><Icon name="shield" size={26} /></div>
        <div className="safety-controller__heading">
          <span className="section-heading__eyebrow">Real-time decision engine</span>
          <h2 id="safety-title">Safety controller</h2>
        </div>
        <DecisionState state={decision.state} />
      </div>

      <div className="decision-layout">
        <div className="decision-copy">
          <span className="decision-copy__label">Current pacing decision</span>
          <h3>{decision.headline}</h3>
          <p>{decision.explanation}</p>
          <div className="decision-reason">
            <Icon name="zap" size={16} />
            <span><strong>Binding constraint:</strong> {decision.limitingFactor}</span>
          </div>
        </div>

        <div className="decision-rate" aria-label={`${decision.approvedCallsPerMinute} calls per minute approved`}>
          <span>Approved rate</span>
          <strong>{decision.approvedCallsPerMinute.toLocaleString()}</strong>
          <small>calls / minute</small>
          <div className="confidence-ring" style={{ '--confidence': `${clamp(decision.confidencePercent)}%` } as CSSProperties}>
            <span>{clamp(decision.confidencePercent).toFixed(0)}%</span>
            <small>confidence</small>
          </div>
        </div>
      </div>

      <div className="rate-comparison">
        <div className="rate-comparison__labels">
          <span>Requested <strong>{decision.requestedCallsPerMinute.toLocaleString()}</strong></span>
          <span>Safe ceiling <strong>{decision.safeCeilingCallsPerMinute.toLocaleString()}</strong></span>
        </div>
        <div className="rate-track" aria-hidden="true">
          <span className="rate-track__requested" style={{ width: `${requestedWidth}%` }} />
          <span className="rate-track__approved" style={{ width: `${approvedWidth}%` }} />
          <span className="rate-track__ceiling" style={{ left: `${ceilingPosition}%` }} />
        </div>
        <div className="rate-comparison__legend">
          <span><i className="legend-dot legend-dot--approved" /> Approved</span>
          <span><i className="legend-dot legend-dot--requested" /> Requested demand</span>
          <span><i className="legend-line" /> Safety ceiling</span>
        </div>
      </div>

      <div className="decision-inputs">
        {decision.inputs.map((input) => (
          <div className={cx('decision-input', `decision-input--${input.tone ?? 'neutral'}`)} key={input.label}>
            <span>{input.label}</span>
            <strong>{input.value}</strong>
            {input.detail ? <small>{input.detail}</small> : null}
          </div>
        ))}
      </div>

      <div className="guardrail-note">
        <Icon name="info" size={15} />
        <span><strong>Active policy:</strong> {decision.guardrail}</span>
      </div>
    </section>
  );
}

interface TrendChartProps {
  points: TrendPoint[];
}

function linePath(values: number[], width: number, height: number, padding: number, maximum: number) {
  if (values.length === 0) return '';
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  return values
    .map((value, index) => {
      const x = padding + (values.length === 1 ? usableWidth / 2 : (index / (values.length - 1)) * usableWidth);
      const y = height - padding - (clamp(value, 0, maximum) / maximum) * usableHeight;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

export function TrendChart({ points }: TrendChartProps) {
  const width = 760;
  const height = 250;
  const padding = 34;
  const allValues = points.flatMap((point) => [point.dialRate, point.safeRate, point.connected]);
  const maximum = Math.max(10, Math.ceil(Math.max(...allValues, 0) * 1.15 / 10) * 10);
  const dialPath = linePath(points.map((point) => point.dialRate), width, height, padding, maximum);
  const safePath = linePath(points.map((point) => point.safeRate), width, height, padding, maximum);
  const connectedPath = linePath(points.map((point) => point.connected), width, height, padding, maximum);
  const areaPath = dialPath ? `${dialPath} L ${width - padding} ${height - padding} L ${padding} ${height - padding} Z` : '';
  const gradientId = `dial-area-${useId().replace(/:/g, '')}`;
  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  const lastPoint = points.at(-1);

  return (
    <section className="panel trend-panel" aria-labelledby="trend-title">
      <SectionHeading
        eyebrow="Pacing telemetry"
        title="Throughput & safe limit"
        titleId="trend-title"
        description="Calls per minute over the active simulation window"
        action={lastPoint ? <span className="chart-current"><i /> Live · {lastPoint.dialRate} CPM</span> : null}
      />
      <div className="chart-legend" aria-hidden="true">
        <span><i className="chart-key chart-key--dial" /> Dial rate</span>
        <span><i className="chart-key chart-key--safe" /> Safe limit</span>
        <span><i className="chart-key chart-key--connect" /> Connections</span>
      </div>
      <div className="chart-wrap">
        {points.length === 0 ? (
          <div className="empty-state"><Icon name="activity" size={22} /><span>Run or step the simulation to build a pacing trace.</span></div>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${gradientId}-title ${gradientId}-desc`}>
            <title id={`${gradientId}-title`}>Dial rate, safe limit and connection trend</title>
            <desc id={`${gradientId}-desc`}>A time-series chart of simulation throughput in calls per minute.</desc>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f15a22" stopOpacity=".22" />
                <stop offset="1" stopColor="#f15a22" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = height - padding - ratio * (height - padding * 2);
              return (
                <g key={ratio}>
                  <line className="chart-gridline" x1={padding} x2={width - padding} y1={y} y2={y} />
                  <text className="chart-y-label" x={padding - 8} y={y + 4} textAnchor="end">{Math.round(maximum * ratio)}</text>
                </g>
              );
            })}
            <path d={areaPath} fill={`url(#${gradientId})`} />
            <path className="chart-line chart-line--safe" d={safePath} />
            <path className="chart-line chart-line--connections" d={connectedPath} />
            <path className="chart-line chart-line--dial" d={dialPath} />
            {points.map((point, index) => {
              if (index % labelStep !== 0 && index !== points.length - 1) return null;
              const x = padding + (points.length === 1 ? (width - padding * 2) / 2 : (index / (points.length - 1)) * (width - padding * 2));
              return <text className="chart-x-label" x={x} y={height - 8} textAnchor="middle" key={`${point.label}-${index}`}>{point.label}</text>;
            })}
            {lastPoint ? (
              <circle
                className="chart-last-point"
                cx={padding + (points.length === 1 ? (width - padding * 2) / 2 : width - padding * 2)}
                cy={height - padding - (lastPoint.dialRate / maximum) * (height - padding * 2)}
                r="4.5"
              />
            ) : null}
          </svg>
        )}
      </div>
    </section>
  );
}

function Distribution({ title, subtitle, items }: { title: string; subtitle: string; items: StateDatum[] }) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  return (
    <div className="distribution">
      <div className="distribution__heading">
        <span>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        <strong className="distribution__total">{total.toLocaleString()}</strong>
      </div>
      <div className="stacked-bar" aria-label={`${title}: ${items.map((item) => `${item.label} ${item.displayValue ?? item.value}`).join(', ')}`}>
        {items.map((item) => (
          <span
            key={item.id}
            style={{ width: `${total === 0 ? 0 : (Math.max(0, item.value) / total) * 100}%`, backgroundColor: item.color }}
            title={`${item.label}: ${item.displayValue ?? item.value}`}
          />
        ))}
      </div>
      <div className="distribution__legend">
        {items.map((item) => (
          <span key={item.id}>
            <i style={{ backgroundColor: item.color }} />
            <span>{item.label}</span>
            <strong>{item.displayValue ?? item.value.toLocaleString()}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function StateDistribution({ agentStates, callStates }: { agentStates: StateDatum[]; callStates: StateDatum[] }) {
  return (
    <section className="panel state-panel" aria-labelledby="state-title">
      <SectionHeading eyebrow="Live inventory" title="Agent & call state" titleId="state-title" description="Capacity and conversation distribution at this decision tick" />
      <div className="state-panel__grid">
        <Distribution title="Agent capacity" subtitle="Current workforce" items={agentStates} />
        <Distribution title="Call lifecycle" subtitle="Current call pool" items={callStates} />
      </div>
    </section>
  );
}

function providerIcon(status: HealthStatus): IconName {
  return status === 'healthy' ? 'check' : status === 'degraded' ? 'latency' : 'warning';
}

function ProviderCard({ provider }: { provider: ProviderHealthDatum }) {
  return (
    <article className={cx('provider-card', `provider-card--${provider.status}`)}>
      <div className="provider-card__topline">
        <span className="provider-card__mark"><Icon name="cloud" size={17} /></span>
        <span className="provider-card__name">
          <strong>{provider.name}</strong>
          <small>{provider.route}</small>
        </span>
        <span className="provider-health"><Icon name={providerIcon(provider.status)} size={12} />{provider.status}</span>
      </div>
      <div className="provider-card__metrics">
        <span><small>Latency</small><strong>{provider.latencyMs} ms</strong></span>
        <span><small>Success</small><strong>{provider.successRatePercent.toFixed(1)}%</strong></span>
        <span><small>Active</small><strong>{provider.activeCalls}</strong></span>
      </div>
      <p>{provider.detail}</p>
    </article>
  );
}

export function ProviderHealth({ providers }: { providers: ProviderHealthDatum[] }) {
  const available = providers.filter((provider) => provider.status !== 'down').length;
  return (
    <section className="panel provider-panel" aria-labelledby="provider-title">
      <SectionHeading
        eyebrow="Route availability"
        title="Provider health"
        titleId="provider-title"
        action={<span className="summary-pill"><i /> {available}/{providers.length} available</span>}
      />
      <div className="provider-list">
        {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)}
      </div>
    </section>
  );
}

function EventIcon({ severity }: { severity: AuditEvent['severity'] }) {
  const icon: IconName = severity === 'critical' ? 'warning' : severity === 'warning' ? 'shield' : severity === 'success' ? 'check' : 'info';
  return <span className={cx('event-icon', `event-icon--${severity}`)}><Icon name={icon} size={14} /></span>;
}

export function EventStream({ events }: { events: AuditEvent[] }) {
  return (
    <section className="panel event-panel" aria-labelledby="events-title">
      <SectionHeading
        eyebrow="Explainable operations"
        title="Decision & audit stream"
        titleId="events-title"
        description="Immutable simulator events, newest first"
        action={<span className="event-count">{events.length} events</span>}
      />
      <div className="event-table-wrap">
        {events.length === 0 ? (
          <div className="empty-state"><Icon name="code" size={22} /><span>Events will appear as the simulator advances.</span></div>
        ) : (
          <ol className="event-list">
            {events.map((event, index) => (
              <li key={event.id} className={cx('event-row', index === 0 && 'event-row--latest')}>
                <time dateTime={event.timestamp}>{event.timestamp}</time>
                <EventIcon severity={event.severity} />
                <div className="event-row__body">
                  <span><strong>{event.title}</strong><small>{event.source}</small></span>
                  <p>{event.detail}</p>
                </div>
                {event.decisionId ? <code>{event.decisionId}</code> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function stageIcon(stage: PipelineStage['id']): IconName {
  const icons: Record<PipelineStage['id'], IconName> = {
    pacing: 'activity',
    safety: 'shield',
    allocator: 'route',
    provider: 'cloud',
  };
  return icons[stage];
}

export function ArchitectureRail({ stages }: { stages: PipelineStage[] }) {
  return (
    <section className="panel architecture-panel" aria-labelledby="architecture-title">
      <SectionHeading eyebrow="Decision architecture" title="Control pipeline" titleId="architecture-title" description="Every dial passes through four observable stages" />
      <div className="pipeline">
        {stages.map((stage, index) => (
          <div className={cx('pipeline-stage', `pipeline-stage--${stage.status}`, stage.id === 'safety' && 'pipeline-stage--safety')} key={stage.id}>
            <span className="pipeline-stage__index">{String(index + 1).padStart(2, '0')}</span>
            <span className="pipeline-stage__icon"><Icon name={stageIcon(stage.id)} size={19} /></span>
            <span className="pipeline-stage__copy">
              <small>{stage.eyebrow}</small>
              <strong>{stage.label}</strong>
              <span>{stage.detail}</span>
            </span>
            <span className="pipeline-stage__metric">{stage.metric}</span>
            {index < stages.length - 1 ? <span className="pipeline-stage__connector" aria-hidden="true"><Icon name="chevron-right" size={13} /></span> : null}
          </div>
        ))}
      </div>
      <div className="architecture-note">
        <span className="architecture-note__icon"><Icon name="database" size={17} /></span>
        <span><strong>Auditable by design</strong><small>Inputs and outputs persist for every decision tick.</small></span>
      </div>
    </section>
  );
}

function FailureSwitch({ item, onToggle }: { item: FailureControl; onToggle?: (id: FailureControl['id'], active: boolean) => void }) {
  return (
    <div className={cx('failure-row', item.active && 'is-active')}>
      <span className="failure-row__icon"><Icon name={item.severity === 'high' ? 'warning' : 'zap'} size={16} /></span>
      <span className="failure-row__copy">
        <strong>{item.label}</strong>
        <small>{item.description}</small>
      </span>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-label={`${item.label} failure injection`}
        aria-checked={item.active}
        onClick={() => onToggle?.(item.id, !item.active)}
      >
        <span />
      </button>
    </div>
  );
}

export function FailureInjection({ failures, onToggle }: { failures: FailureControl[]; onToggle?: (id: FailureControl['id'], active: boolean) => void }) {
  const activeCount = failures.filter((failure) => failure.active).length;
  return (
    <section className={cx('panel failure-panel', activeCount > 0 && 'failure-panel--armed')} aria-labelledby="failure-title">
      <SectionHeading
        eyebrow="Resilience lab"
        title="Failure injection"
        titleId="failure-title"
        description="Apply controlled shocks without bypassing safety"
        action={activeCount > 0 ? <span className="armed-pill"><Icon name="warning" size={12} /> {activeCount} armed</span> : null}
      />
      <div className="failure-list">
        {failures.map((failure) => <FailureSwitch item={failure} onToggle={onToggle} key={failure.id} />)}
      </div>
      <div className="failure-footnote"><Icon name="shield" size={14} /><span>Safety controller stays authoritative during every test.</span></div>
    </section>
  );
}

export function AssignmentNote() {
  return (
    <footer className="assignment-note">
      <div className="assignment-note__loop" aria-hidden="true"><BrandLoop /></div>
      <div>
        <span className="section-heading__eyebrow">CredResolve engineering assignment</span>
        <strong>Designed for safe, explainable recovery conversations.</strong>
        <p>This simulation demonstrates an observable pacing loop—not a production dialer. No customer data or real calls are used.</p>
      </div>
      <div className="assignment-note__tags" aria-label="Project characteristics">
        <span><Icon name="shield" size={13} /> Safety first</span>
        <span><Icon name="code" size={13} /> Deterministic</span>
        <span><Icon name="activity" size={13} /> Observable</span>
      </div>
    </footer>
  );
}

export function SmartDialerDashboard({
  viewModel,
  className,
  onModeChange,
  onScenarioSelect,
  onRun,
  onPause,
  onStep,
  onReset,
  onFailureToggle,
}: DashboardProps) {
  return (
    <div className={cx('dashboard-app', className)}>
      <DashboardHeader status={viewModel.status} elapsedTime={viewModel.elapsedTime} lastUpdatedLabel={viewModel.lastUpdatedLabel} />
      <main className="dashboard-main" id="main-content">
        <ControlDeck
          mode={viewModel.mode}
          scenarios={viewModel.scenarios}
          selectedScenarioId={viewModel.selectedScenarioId}
          status={viewModel.status}
          simulationClock={viewModel.simulationClock}
          nextDecisionIn={viewModel.nextDecisionIn}
          onModeChange={onModeChange}
          onScenarioSelect={onScenarioSelect}
          onRun={onRun}
          onPause={onPause}
          onStep={onStep}
          onReset={onReset}
        />

        <MetricGrid metrics={viewModel.metrics} />

        <div className="dashboard-columns">
          <div className="dashboard-columns__primary">
            <SafetyController decision={viewModel.safetyDecision} />
            <TrendChart points={viewModel.trend} />
            <StateDistribution agentStates={viewModel.agentStates} callStates={viewModel.callStates} />
            <EventStream events={viewModel.events} />
          </div>
          <aside className="dashboard-columns__aside" aria-label="Infrastructure and resilience">
            <ArchitectureRail stages={viewModel.pipeline} />
            <ProviderHealth providers={viewModel.providers} />
            <FailureInjection failures={viewModel.failures} onToggle={onFailureToggle} />
          </aside>
        </div>

        <AssignmentNote />
      </main>
    </div>
  );
}

export default SmartDialerDashboard;
