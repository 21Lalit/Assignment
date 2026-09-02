import { CallAllocator, InMemoryDialerStore } from './allocator';
import {
  PredictivePacingEngine,
  ProgressivePacingEngine,
  SafetyController,
} from './pacing';
import {
  ChaosMockProvider,
  CircuitBreaker,
  ReliableMockProvider,
  type TelecomProvider,
} from './providers';
import { clamp, round, SeededRandom } from './random';
import { getScenario } from './scenarios';
import {
  CallEventReducer,
  isTerminalCallState,
  transitionAgent,
  transitionCall,
} from './state-machines';
import type {
  Agent,
  AgentState,
  Borrower,
  BorrowerState,
  CallSnapshot,
  CallState,
  DialerCall,
  DialerMetrics,
  DialerRates,
  InvariantSnapshot,
  PaceProposal,
  PacingContext,
  ProviderEvent,
  ProviderKind,
  ProviderStatus,
  SafetyDecision,
  ScenarioId,
  ScheduledProviderEvent,
  SimulatorCommand,
  SimulatorConfig,
  SimulatorConfigInput,
  SimulatorSnapshot,
  TimelineEntry,
  TrendPoint,
  WorkerSnapshot,
} from './types';

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  mode: 'PREDICTIVE',
  provider: 'RELIABLE',
  seed: 'credresolve-2026',
  agentCount: 40,
  borrowerCount: 400,
  workerCount: 3,
  tickMs: 1_000,
  leaseMs: 8_000,
  wrapUpMs: 4_000,
  answerRate: 0.38,
  averageSetupMs: 4_500,
  averageTalkMs: 90_000,
  ewmaAlpha: 0.18,
  initialHistoricalSamples: 50,
  maxBatchSize: 100,
  minAnswerRate: 0.08,
  confidenceZ: 3.5,
  timelineLimit: 160,
  safety: {
    minProviderHealth: 0.72,
    minHistoricalSamples: 20,
    progressiveFallbackBatch: 1,
    maxProviderInFlight: 500,
    deterministicReservation: true,
  },
  circuitBreaker: {
    failureThreshold: 3,
    windowSize: 20,
    openDurationMs: 15_000,
    halfOpenSuccesses: 1,
  },
  chaosProvider: {
    timeoutRate: 0.1,
    failureRate: 0.05,
    duplicateRate: 0.25,
    outOfOrderRate: 0.2,
    minimumLatencyMs: 400,
    maximumLatencyMs: 1_800,
  },
};

interface WorkerRuntime extends WorkerSnapshot {}

interface RuntimeOverride<T> {
  value: T;
  until: number;
}

export class SmartDialerSimulator {
  private readonly store = new InMemoryDialerStore();
  private readonly allocator = new CallAllocator(this.store);
  private readonly eventReducer = new CallEventReducer();

  private configState: SimulatorConfig = mergeConfig(DEFAULT_SIMULATOR_CONFIG, {});
  private random = new SeededRandom(this.configState.seed);
  private reliableProvider: ReliableMockProvider = new ReliableMockProvider();
  private chaosProvider: ChaosMockProvider = new ChaosMockProvider(this.configState.chaosProvider);
  private breaker = new CircuitBreaker(this.configState.circuitBreaker);
  private safetyController = new SafetyController(this.configState.safety);
  private readonly progressivePacing = new ProgressivePacingEngine();
  private readonly predictivePacing = new PredictivePacingEngine();
  private workers = new Map<string, WorkerRuntime>();
  private scheduledEvents: ScheduledProviderEvent[] = [];
  private wrapUpDue = new Map<string, number>();
  private timelineEntries: TimelineEntry[] = [];
  private trendEntries: TrendPoint[] = [];
  private answerOutcomes: boolean[] = [];
  private observedCallOutcomes = new Set<string>();
  private finalizedCalls = new Set<string>();
  private metricsState: DialerMetrics = emptyMetrics();
  private ewmaAnswerRate = this.configState.answerRate;
  private nowMs = 0;
  private eventSequence = 0;
  private timelineSequence = 0;
  private borrowerSequence = 0;
  private isRunning = false;
  private outageUntil?: number;
  private latencyOverride?: RuntimeOverride<number>;
  private answerOverride?: RuntimeOverride<number>;
  private webhookLossOverride?: RuntimeOverride<number>;
  private lastProposal!: PaceProposal;
  private lastDecision!: SafetyDecision;

  constructor(config: SimulatorConfigInput = {}) {
    this.reset(config);
  }

  get config(): SimulatorConfig {
    return this.configState;
  }

  get now(): number {
    return this.nowMs;
  }

  configure(input: SimulatorConfigInput): SimulatorSnapshot {
    const next = mergeConfig(this.configState, input);
    const structuralChange =
      next.agentCount !== this.store.agents.size ||
      next.borrowerCount !== this.store.borrowers.size ||
      next.workerCount !== this.workers.size ||
      next.seed !== this.configState.seed;
    if (structuralChange) return this.reset(next);

    const providerInfrastructureChanged =
      JSON.stringify(next.circuitBreaker) !== JSON.stringify(this.configState.circuitBreaker) ||
      JSON.stringify(next.chaosProvider) !== JSON.stringify(this.configState.chaosProvider);
    this.configState = next;
    this.safetyController = new SafetyController(next.safety);
    if (providerInfrastructureChanged) {
      this.chaosProvider = new ChaosMockProvider(next.chaosProvider);
      this.breaker = new CircuitBreaker(next.circuitBreaker);
    }
    this.refreshDecisionPreview();
    this.log('SYSTEM', 'INFO', `Configuration updated (${next.mode}, ${next.provider}).`);
    return this.snapshot();
  }

  reset(input: SimulatorConfigInput = {}): SimulatorSnapshot {
    let base = mergeConfig(DEFAULT_SIMULATOR_CONFIG, input);
    if (input.scenario) {
      const scenario = getScenario(input.scenario);
      base = mergeConfig(mergeConfig(DEFAULT_SIMULATOR_CONFIG, scenario.config), input);
    }
    this.configState = base;
    this.random = new SeededRandom(base.seed);
    this.reliableProvider = new ReliableMockProvider();
    this.chaosProvider = new ChaosMockProvider(base.chaosProvider);
    this.breaker = new CircuitBreaker(base.circuitBreaker);
    this.safetyController = new SafetyController(base.safety);
    this.store.clear();
    this.allocator.resetSequence();
    this.workers.clear();
    this.scheduledEvents = [];
    this.wrapUpDue.clear();
    this.timelineEntries = [];
    this.trendEntries = [];
    this.answerOutcomes = [];
    this.observedCallOutcomes.clear();
    this.finalizedCalls.clear();
    this.metricsState = emptyMetrics();
    this.ewmaAnswerRate = base.answerRate;
    this.nowMs = 0;
    this.eventSequence = 0;
    this.timelineSequence = 0;
    this.borrowerSequence = 0;
    this.isRunning = false;
    this.outageUntil = undefined;
    this.latencyOverride = undefined;
    this.answerOverride = undefined;
    this.webhookLossOverride = undefined;

    for (let index = 1; index <= base.agentCount; index += 1) {
      this.store.addAgent({
        id: `agent-${index}`,
        state: 'AVAILABLE',
        version: 0,
        stateSince: 0,
        callsHandled: 0,
      });
    }
    this.addBorrowers(base.borrowerCount);
    for (let index = 1; index <= base.workerCount; index += 1) {
      const id = `worker-${index}`;
      this.workers.set(id, { id, active: true, ownedCalls: 0 });
    }

    this.refreshDecisionPreview();
    this.log(
      'SYSTEM',
      'SUCCESS',
      `Simulator reset with ${base.agentCount} agents, ${base.borrowerCount} borrowers and seed ${String(base.seed)}.`,
    );
    this.recordTrend();
    return this.snapshot();
  }

  step(durationMs = this.configState.tickMs): SimulatorSnapshot {
    const duration = Math.max(1, Math.floor(durationMs));
    this.advance(duration);
    return this.snapshot();
  }

  /** Advances domain state without materializing a UI snapshot for every tick. */
  private advance(duration: number): void {
    this.accumulateAgentTime(duration);
    this.nowMs += duration;
    this.expireRuntimeOverrides();
    this.recoverWorkersByTimer();
    this.breaker.tick(this.nowMs);
    this.processWrapUps();
    this.processProviderEvents();
    this.heartbeatAndRecoverLeases();
    this.executePacingCycle();
    this.recordTrend();
  }

  run(steps = 60, durationMs = this.configState.tickMs): SimulatorSnapshot {
    this.isRunning = true;
    const count = Math.max(0, Math.floor(steps));
    const duration = Math.max(1, Math.floor(durationMs));
    for (let index = 0; index < count; index += 1) this.advance(duration);
    this.isRunning = false;
    return this.snapshot();
  }

  runScenario(
    scenario: ScenarioId | string,
    steps = 90,
    durationMs = this.configState.tickMs,
  ): SimulatorSnapshot {
    const id = normalizeScenarioId(scenario);
    this.reset({ ...getScenario(id).config, scenario: id, seed: `${String(this.configState.seed)}:${id}` });
    this.isRunning = true;
    const count = Math.max(1, Math.floor(steps));
    const duration = Math.max(1, Math.floor(durationMs));
    for (let index = 0; index < count; index += 1) {
      if (id === 'CRASH' && index === 2) this.inject({ type: 'WORKER_CRASH', workerId: 'worker-1' });
      if (id === 'OUTAGE' && index === 4) this.inject({ type: 'PROVIDER_OUTAGE', durationMs: 15_000 });
      if (id === 'AGENT_DROP' && index === 3) this.inject({ type: 'AGENT_DROP', count: 40 });
      this.advance(duration);
    }
    this.isRunning = false;
    return this.snapshot();
  }

  inject(command: SimulatorCommand): SimulatorSnapshot;
  inject(command: { type: string } & Record<string, unknown>): SimulatorSnapshot;
  inject(command: { type: string } & Record<string, unknown>): SimulatorSnapshot {
    const kind = String(command.type).trim().toUpperCase().replace(/[ -]+/g, '_');
    switch (kind) {
      case 'SET_MODE': {
        const mode = String(command.mode).toUpperCase();
        if (mode === 'PROGRESSIVE' || mode === 'PREDICTIVE') this.configState.mode = mode;
        this.log('SYSTEM', 'INFO', `Dial mode changed to ${this.configState.mode}.`);
        break;
      }
      case 'SET_AGENT_STATE': {
        const agent = this.store.agents.get(String(command.agentId));
        if (agent && isAgentState(command.state)) this.setAgentState(agent, command.state);
        break;
      }
      case 'AGENT_DROP': {
        const count = Math.max(0, Math.floor(Number(command.count) || 0));
        let changed = 0;
        for (const agent of this.store.agents.values()) {
          if (changed >= count) break;
          if (agent.state !== 'AVAILABLE') continue;
          this.setAgentState(agent, 'OFFLINE');
          changed += 1;
        }
        this.log('AGENT', 'WARN', `${changed} available agents went offline; capacity is re-evaluated immediately.`);
        break;
      }
      case 'WORKER_CRASH': {
        this.crashWorker(command.workerId ? String(command.workerId) : undefined, Number(command.recoverAfterMs) || undefined);
        break;
      }
      case 'WORKER_RECOVER': {
        this.recoverWorker(command.workerId ? String(command.workerId) : undefined);
        break;
      }
      case 'PROVIDER_OUTAGE': {
        const duration = Math.max(1, Number(command.durationMs) || this.configState.circuitBreaker.openDurationMs);
        this.outageUntil = Math.max(this.outageUntil ?? 0, this.nowMs + duration);
        this.breaker.forceOpen(this.nowMs, duration);
        this.log('PROVIDER', 'ERROR', `Provider outage injected for ${duration}ms; circuit opened.`);
        break;
      }
      case 'PROVIDER_LATENCY': {
        const latencyMs = Math.max(0, Number(command.latencyMs) || 0);
        const duration = Math.max(1, Number(command.durationMs) || 30_000);
        this.latencyOverride = { value: latencyMs, until: this.nowMs + duration };
        this.log('PROVIDER', 'WARN', `Provider latency increased by ${latencyMs}ms for ${duration}ms.`);
        break;
      }
      case 'ANSWER_SPIKE': {
        const answerRate = clamp(Number(command.answerRate) || 0.9, 0, 1);
        const duration = Math.max(1, Number(command.durationMs) || 30_000);
        this.answerOverride = { value: answerRate, until: this.nowMs + duration };
        this.log('PACING', 'WARN', `Answer-rate spike to ${round(answerRate * 100, 1)}% for ${duration}ms.`);
        break;
      }
      case 'WEBHOOK_LOSS': {
        const lossRate = clamp(Number(command.lossRate) || 0.5, 0, 1);
        const duration = Math.max(1, Number(command.durationMs) || 20_000);
        this.webhookLossOverride = { value: lossRate, until: this.nowMs + duration };
        this.log('PROVIDER', 'WARN', `Webhook loss set to ${round(lossRate * 100, 1)}% for ${duration}ms.`);
        break;
      }
      case 'CLEAR_RUNTIME_OVERRIDE': {
        const override = String(command.override).toUpperCase();
        if (override === 'PROVIDER_LATENCY') this.latencyOverride = undefined;
        if (override === 'ANSWER_SPIKE') this.answerOverride = undefined;
        if (override === 'WEBHOOK_LOSS') this.webhookLossOverride = undefined;
        if (override === 'PROVIDER_OUTAGE') {
          this.outageUntil = undefined;
          this.breaker.reset();
        }
        this.log('SYSTEM', 'INFO', `${override.replace(/_/g, ' ').toLowerCase()} override cleared.`);
        break;
      }
      case 'PROVIDER_EVENT': {
        const event = command.event as ProviderEvent | undefined;
        if (event) this.applyProviderEvent({ ...event, receivedAt: this.nowMs });
        break;
      }
      case 'ENQUEUE_BORROWERS': {
        this.addBorrowers(Math.max(0, Math.floor(Number(command.count) || 0)));
        break;
      }
      case 'SET_CONDITIONS': {
        if (command.answerRate !== undefined) this.configState.answerRate = clamp(Number(command.answerRate), 0, 1);
        if (command.averageSetupMs !== undefined) this.configState.averageSetupMs = Math.max(1, Number(command.averageSetupMs));
        if (command.averageTalkMs !== undefined) this.configState.averageTalkMs = Math.max(1, Number(command.averageTalkMs));
        if (command.provider === 'RELIABLE' || command.provider === 'CHAOS') {
          this.configState.provider = command.provider;
          this.breaker.reset();
        }
        break;
      }
      case 'SCENARIO': {
        const scenario = normalizeScenarioId(String(command.scenario));
        return this.reset({ ...getScenario(scenario).config, scenario });
      }
      default:
        this.log('SYSTEM', 'WARN', `Unknown injection '${command.type}' ignored.`);
    }
    this.refreshDecisionPreview();
    return this.snapshot();
  }

  snapshot(options: { entityLimit?: number } = {}): SimulatorSnapshot {
    const context = this.buildPacingContext();
    const provider = this.providerStatus();
    const limit = options.entityLimit ?? Number.POSITIVE_INFINITY;
    const agents = Array.from(this.store.agents.values(), cloneAgent).slice(0, limit);
    const borrowers = Array.from(this.store.borrowers.values(), cloneBorrower).slice(0, limit);
    const calls = Array.from(this.store.calls.values(), cloneCall).slice(-limit);
    return {
      now: this.nowMs,
      elapsedMs: this.nowMs,
      mode: this.configState.mode,
      scenario: this.configState.scenario,
      running: this.isRunning,
      config: cloneConfig(this.configState),
      agents,
      agentCounts: countAgents(this.store.agents.values()),
      borrowers,
      borrowerCounts: countBorrowers(this.store.borrowers.values()),
      calls,
      callCounts: countCalls(this.store.calls.values()),
      workers: this.workerSnapshots(),
      metrics: { ...this.metricsState },
      rates: this.calculateRates(context, provider),
      pacing: cloneProposal(this.lastProposal),
      safety: { ...this.lastDecision },
      provider,
      timeline: this.timelineEntries.map((entry) => ({ ...entry })),
      trends: this.trendEntries.map((entry) => ({ ...entry })),
      invariants: this.auditInvariants(),
      queueDepth: context.readyBorrowers,
      nextProviderEvents: this.scheduledEvents.length,
    };
  }

  private executePacingCycle(): void {
    const context = this.buildPacingContext();
    const engine = this.configState.mode === 'PROGRESSIVE' ? this.progressivePacing : this.predictivePacing;
    const proposal = engine.propose(context);
    const decision = this.safetyController.evaluate(proposal, context);
    this.lastProposal = proposal;
    this.lastDecision = decision;
    this.recordSafetyMetric(decision);
    this.log('PACING', 'INFO', `${proposal.mode} pacing requested ${proposal.requestedCalls}: ${proposal.explanation}`);
    this.log(
      'SAFETY',
      decision.action === 'REJECT' ? 'WARN' : decision.action === 'APPROVE' ? 'SUCCESS' : 'INFO',
      `${decision.action}: ${decision.explanation}`,
    );
    if (decision.approvedCalls <= 0) return;

    const activeWorkers = Array.from(this.workers.values()).filter((worker) => worker.active).map((worker) => worker.id);
    if (activeWorkers.length === 0) {
      this.log('RECOVERY', 'ERROR', 'No active worker can own a new call; allocation skipped.');
      return;
    }
    const progressiveAllocation = proposal.mode === 'PROGRESSIVE' || decision.action === 'FALLBACK_PROGRESSIVE';
    const reservation = progressiveAllocation
      ? this.allocator.reserveNextBatch(decision.approvedCalls, activeWorkers, this.nowMs, this.configState.leaseMs)
      : this.allocator.reserveBorrowerBatch(decision.approvedCalls, activeWorkers, this.nowMs, this.configState.leaseMs);
    this.metricsState.reservations += reservation.calls.length;
    this.metricsState.casConflicts += reservation.conflicts;
    for (const call of reservation.calls) {
      call.dialMode = progressiveAllocation ? 'PROGRESSIVE' : 'PREDICTIVE';
      this.startCall(call);
    }
  }

  private startCall(call: DialerCall): void {
    if (isTerminalCallState(call.state) || call.state !== 'RESERVED') return;
    if (call.agentId) {
      const agent = this.store.agents.get(call.agentId);
      if (!agent || agent.reservedCallId !== call.id || agent.state !== 'RESERVED') {
        transitionCall(call, 'CANCELLED', this.nowMs, 'DIALER', { reason: 'LOST_AGENT_RESERVATION' });
        this.finalizeCall(call);
        return;
      }
      transitionAgent(agent, 'DIALING', this.nowMs);
    }
    const borrower = this.store.borrowers.get(call.borrowerId);
    if (borrower) borrower.attempts += 1;
    transitionCall(call, 'INITIATED', this.nowMs, 'DIALER');
    this.metricsState.callsInitiated += 1;
    this.metricsState.providerRequests += 1;

    if (!this.breaker.allowRequest(this.nowMs)) {
      this.metricsState.providerFailures += 1;
      transitionCall(call, 'FAILED', this.nowMs, 'DIALER', { reason: 'CIRCUIT_OPEN' });
      this.finalizeCall(call);
      return;
    }
    if (this.outageUntil !== undefined && this.nowMs < this.outageUntil) {
      this.breaker.recordFailure(this.nowMs);
      this.metricsState.providerFailures += 1;
      transitionCall(call, 'FAILED', this.nowMs, 'DIALER', { reason: 'PROVIDER_OUTAGE' });
      this.finalizeCall(call);
      return;
    }

    const provider = this.currentProvider();
    const result = provider.initiate(
      {
        callId: call.id,
        borrowerId: call.borrowerId,
        agentId: call.agentId,
        idempotencyKey: call.id,
        answerProbability: this.effectiveAnswerRate(),
        averageSetupMs: this.effectiveTalkConditions().setupMs,
        averageTalkMs: this.effectiveTalkConditions().talkMs,
      },
      this.nowMs,
      this.random,
    );
    if (!result.accepted || !result.providerCallId) {
      this.breaker.recordFailure(this.nowMs, result.latencyMs);
      this.metricsState.providerFailures += 1;
      transitionCall(call, 'FAILED', this.nowMs, 'DIALER', { reason: result.error ?? 'PROVIDER_REJECTED' });
      this.log('PROVIDER', 'ERROR', `${provider.name} rejected ${call.id}: ${result.error ?? 'unknown error'}.`, call);
      this.finalizeCall(call);
      return;
    }

    this.breaker.recordSuccess(result.latencyMs);
    call.providerCallId = result.providerCallId;
    call.providerKind = provider.kind;
    call.version += 1;
    const extraLatency = this.latencyOverride && this.latencyOverride.until > this.nowMs ? this.latencyOverride.value : 0;
    for (const event of result.events) {
      this.scheduledEvents.push({ ...event, dueAt: event.dueAt + extraLatency, sequence: ++this.eventSequence });
    }
    this.scheduledEvents.sort(compareScheduledEvents);
    this.metricsState.peakProviderInFlight = Math.max(
      this.metricsState.peakProviderInFlight,
      this.buildPacingContext().providerInFlight,
    );
    this.log(
      'CALL',
      'INFO',
      `${call.id} initiated via ${provider.name}${call.agentId ? ` for ${call.agentId}` : ' as predictive prospecting'}.`,
      call,
    );
  }

  private processProviderEvents(): void {
    if (this.scheduledEvents.length === 0) return;
    const due: ScheduledProviderEvent[] = [];
    const pending: ScheduledProviderEvent[] = [];
    for (const event of this.scheduledEvents) {
      if (event.dueAt <= this.nowMs) due.push(event);
      else pending.push(event);
    }
    this.scheduledEvents = pending;
    due.sort(compareScheduledEvents);
    for (const event of due) {
      if (this.outageUntil !== undefined && this.nowMs < this.outageUntil) {
        this.scheduledEvents.push({ ...event, dueAt: this.outageUntil + (event.sequence % 17) });
        continue;
      }
      const lossRate =
        this.webhookLossOverride && this.webhookLossOverride.until > this.nowMs
          ? this.webhookLossOverride.value
          : 0;
      if (lossRate > 0 && this.random.chance(lossRate)) {
        const retryAt = Math.max(this.nowMs + this.configState.tickMs, this.webhookLossOverride?.until ?? this.nowMs);
        this.scheduledEvents.push({ ...event, dueAt: retryAt + (event.sequence % 31) });
        this.log('PROVIDER', 'WARN', `Webhook ${event.id} was lost; reconciliation queued a deterministic retry.`);
        continue;
      }
      this.applyProviderEvent({ ...event, receivedAt: this.nowMs });
    }
    this.scheduledEvents.sort(compareScheduledEvents);
  }

  private applyProviderEvent(event: ProviderEvent): void {
    const call = this.store.calls.get(event.callId);
    if (!call) {
      this.metricsState.unknownEventsIgnored += 1;
      this.log('PROVIDER', 'WARN', `Unknown provider event ${event.id} ignored.`);
      return;
    }
    // CONNECTED is treated as an answer signal first. The internal CONNECTED
    // transition is committed only after answer-time agent CAS succeeds.
    const reducerEvent: ProviderEvent =
      event.type === 'CONNECTED' && !isTerminalCallState(call.state)
        ? { ...event, type: 'ANSWERED' }
        : event;
    const result = this.eventReducer.apply(call, reducerEvent, this.nowMs);
    if (result.outcome === 'DUPLICATE') this.metricsState.duplicateEventsIgnored += 1;
    if (result.outcome === 'OUT_OF_ORDER') this.metricsState.outOfOrderEventsIgnored += 1;
    if (result.outcome === 'TERMINAL_IGNORED') this.metricsState.terminalEventsIgnored += 1;
    if (result.outcome === 'UNKNOWN') this.metricsState.unknownEventsIgnored += 1;
    if (result.outcome !== 'APPLIED') {
      this.log('PROVIDER', 'WARN', `${result.outcome} event ${event.type} ignored for ${call.id}.`, call);
      return;
    }

    this.log('CALL', event.type === 'COMPLETED' ? 'SUCCESS' : 'INFO', `${call.id}: ${result.previousState} -> ${call.state}.`, call);
    if (call.state === 'ANSWERED' || (call.state === 'CONNECTED' && !call.agentId)) {
      this.handleAnsweredCall(call);
    }
    if (isTerminalCallState(call.state)) this.finalizeCall(call);
  }

  private handleAnsweredCall(call: DialerCall): void {
    this.metricsState.callsAnswered += 1;
    this.recordCallAnswerOutcome(call, true);
    if (!call.agentId) {
      const agent = Array.from(this.store.agents.values()).find((candidate) => candidate.state === 'AVAILABLE');
      if (!agent) {
        this.metricsState.unservedAnswers += 1;
        this.metricsState.safetyBreaches += 1;
        transitionCall(call, 'CANCELLED', this.nowMs, 'DIALER', { reason: 'NO_AGENT_AT_ANSWER' });
        this.log('SAFETY', 'ERROR', `Safety breach: ${call.id} answered without an available agent.`, call);
        this.finalizeCall(call);
        return;
      }
      const assignment = this.allocator.assignAgent(
        call.id,
        agent.id,
        this.nowMs,
        this.configState.leaseMs,
        agent.version,
        call.version,
      );
      if (!assignment.ok) {
        this.metricsState.casConflicts += 1;
        // A racing assignment lost CAS; retry another currently AVAILABLE agent once.
        const retry = Array.from(this.store.agents.values()).find((candidate) => candidate.state === 'AVAILABLE');
        const retried = retry
          ? this.allocator.assignAgent(
              call.id,
              retry.id,
              this.nowMs,
              this.configState.leaseMs,
              retry.version,
              call.version,
            )
          : undefined;
        if (!retried?.ok) {
          this.metricsState.unservedAnswers += 1;
          this.metricsState.safetyBreaches += 1;
          transitionCall(call, 'CANCELLED', this.nowMs, 'DIALER', { reason: 'AGENT_ASSIGNMENT_RACE' });
          this.finalizeCall(call);
          return;
        }
      }
    }

    const agent = call.agentId ? this.store.agents.get(call.agentId) : undefined;
    if (!agent) return;
    if (agent.state === 'RESERVED') transitionAgent(agent, 'DIALING', this.nowMs);
    if (agent.state === 'DIALING') transitionAgent(agent, 'CONNECTED', this.nowMs);
    if (call.state !== 'CONNECTED') transitionCall(call, 'CONNECTED', this.nowMs, 'DIALER');
    const borrower = this.store.borrowers.get(call.borrowerId);
    if (borrower) {
      borrower.state = 'IN_CALL';
      borrower.version += 1;
    }
    this.metricsState.callsConnected += 1;
  }

  private finalizeCall(call: DialerCall): void {
    if (!isTerminalCallState(call.state) || this.finalizedCalls.has(call.id)) return;
    this.finalizedCalls.add(call.id);
    call.leaseExpiresAt = 0;
    if (call.state === 'COMPLETED') this.metricsState.callsCompleted += 1;
    else if (call.state === 'FAILED') this.metricsState.callsFailed += 1;
    else this.metricsState.callsCancelled += 1;

    const answered = call.state === 'COMPLETED' || call.answeredAt !== undefined || call.connectedAt !== undefined;
    if (call.providerCallId) this.recordCallAnswerOutcome(call, answered);
    const borrower = this.store.borrowers.get(call.borrowerId);
    if (borrower?.reservedCallId === call.id) {
      borrower.reservedCallId = undefined;
      borrower.leaseExpiresAt = undefined;
      borrower.state = call.state === 'COMPLETED' || borrower.attempts >= 3 ? 'DONE' : 'READY';
      borrower.version += 1;
    }

    if (call.agentId) {
      const agent = this.store.agents.get(call.agentId);
      if (agent?.reservedCallId === call.id) {
        agent.reservedCallId = undefined;
        agent.leaseExpiresAt = undefined;
        if (agent.state === 'CONNECTED') {
          transitionAgent(agent, 'WRAP_UP', this.nowMs);
          agent.callsHandled += 1;
          this.wrapUpDue.set(agent.id, this.nowMs + this.configState.wrapUpMs);
        } else if (agent.state === 'RESERVED' || agent.state === 'DIALING') {
          transitionAgent(agent, 'AVAILABLE', this.nowMs);
        }
      }
    }
  }

  private heartbeatAndRecoverLeases(): void {
    const activeWorkers = Array.from(this.workers.values()).filter((worker) => worker.active);
    for (const call of this.store.calls.values()) {
      if (isTerminalCallState(call.state)) continue;
      const worker = this.workers.get(call.workerId);
      if (worker?.active) {
        this.extendLease(call);
        continue;
      }
      if (call.leaseExpiresAt > this.nowMs || activeWorkers.length === 0) continue;
      const replacement = activeWorkers[call.recoveredCount % activeWorkers.length];
      call.workerId = replacement.id;
      call.recoveredCount += 1;
      call.version += 1;
      call.updatedAt = this.nowMs;
      this.extendLease(call);
      this.metricsState.leasesRecovered += 1;
      this.log('RECOVERY', 'SUCCESS', `${replacement.id} adopted expired lease for ${call.id}.`, call);
      if (call.state === 'RESERVED') this.startCall(call);
    }
  }

  private extendLease(call: DialerCall): void {
    const expiry = this.nowMs + this.configState.leaseMs;
    call.leaseExpiresAt = expiry;
    const borrower = this.store.borrowers.get(call.borrowerId);
    if (borrower?.reservedCallId === call.id) borrower.leaseExpiresAt = expiry;
    if (call.agentId) {
      const agent = this.store.agents.get(call.agentId);
      if (agent?.reservedCallId === call.id) agent.leaseExpiresAt = expiry;
    }
  }

  private processWrapUps(): void {
    for (const [agentId, dueAt] of this.wrapUpDue) {
      if (dueAt > this.nowMs) continue;
      const agent = this.store.agents.get(agentId);
      if (agent?.state === 'WRAP_UP') transitionAgent(agent, 'AVAILABLE', this.nowMs);
      this.wrapUpDue.delete(agentId);
    }
  }

  private setAgentState(agent: Agent, state: AgentState): void {
    if (agent.state === state) return;
    if (agent.reservedCallId && ['OFFLINE', 'PAUSED'].includes(state)) {
      const call = this.store.calls.get(agent.reservedCallId);
      if (call && !isTerminalCallState(call.state)) {
        transitionCall(call, 'CANCELLED', this.nowMs, 'OPERATOR', { reason: `AGENT_${state}` });
        this.finalizeCall(call);
      }
    }
    if (agent.state !== state) transitionAgent(agent, state, this.nowMs);
    this.log('AGENT', state === 'OFFLINE' ? 'WARN' : 'INFO', `${agent.id} is now ${state}.`, undefined, agent);
  }

  private crashWorker(workerId?: string, recoverAfterMs?: number): void {
    const worker = workerId ? this.workers.get(workerId) : Array.from(this.workers.values()).find((item) => item.active);
    if (!worker || !worker.active) return;
    worker.active = false;
    worker.crashedAt = this.nowMs;
    worker.recoverAt = recoverAfterMs ? this.nowMs + Math.max(1, recoverAfterMs) : undefined;
    this.metricsState.workerCrashes += 1;
    this.log('RECOVERY', 'ERROR', `${worker.id} crashed; owned calls retain leases until recovery.`);
  }

  private recoverWorker(workerId?: string): void {
    const worker = workerId ? this.workers.get(workerId) : Array.from(this.workers.values()).find((item) => !item.active);
    if (!worker) return;
    worker.active = true;
    worker.recoverAt = undefined;
    this.log('RECOVERY', 'SUCCESS', `${worker.id} returned to service.`);
  }

  private recoverWorkersByTimer(): void {
    for (const worker of this.workers.values()) {
      if (!worker.active && worker.recoverAt !== undefined && worker.recoverAt <= this.nowMs) this.recoverWorker(worker.id);
    }
  }

  private refreshDecisionPreview(): void {
    const context = this.buildPacingContext();
    this.lastProposal =
      this.configState.mode === 'PROGRESSIVE'
        ? this.progressivePacing.propose(context)
        : this.predictivePacing.propose(context);
    this.lastDecision = this.safetyController.evaluate(this.lastProposal, context);
  }

  private buildPacingContext(): PacingContext {
    const agentCounts = countAgents(this.store.agents.values());
    const borrowerCounts = countBorrowers(this.store.borrowers.values());
    const callCounts = countCalls(this.store.calls.values());
    let providerInFlight = 0;
    let unassignedInFlightCalls = 0;
    for (const call of this.store.calls.values()) {
      if (isTerminalCallState(call.state) || call.state === 'RESERVED') continue;
      providerInFlight += 1;
      if (!call.agentId && ['INITIATED', 'RINGING', 'ANSWERED'].includes(call.state)) unassignedInFlightCalls += 1;
    }
    const provider = this.providerStatus();
    return {
      mode: this.configState.mode,
      now: this.nowMs,
      availableAgents: agentCounts.AVAILABLE,
      reservedAgents: agentCounts.RESERVED,
      dialingAgents: agentCounts.DIALING,
      connectedAgents: agentCounts.CONNECTED,
      wrapUpAgents: agentCounts.WRAP_UP,
      readyBorrowers: borrowerCounts.READY,
      queuedCalls: callCounts.QUEUED,
      initiatedCalls: callCounts.INITIATED,
      ringingCalls: callCounts.RINGING,
      answeredCalls: callCounts.ANSWERED,
      connectedCalls: callCounts.CONNECTED,
      providerInFlight,
      unassignedInFlightCalls,
      providerHeadroom: Math.max(0, this.configState.safety.maxProviderInFlight - providerInFlight),
      providerHealth: provider.healthScore,
      circuitState: provider.circuitState,
      ewmaAnswerRate: this.ewmaAnswerRate,
      recentAnswerRate: this.recentAnswerRate(),
      historicalSamples: this.configState.initialHistoricalSamples + this.answerOutcomes.length,
      averageSetupMs: this.effectiveTalkConditions().setupMs,
      averageTalkMs: this.effectiveTalkConditions().talkMs,
      maxBatchSize: this.configState.maxBatchSize,
      minAnswerRate: this.configState.minAnswerRate,
      confidenceZ: this.configState.confidenceZ,
    };
  }

  private providerStatus(): ProviderStatus {
    const provider = this.currentProvider();
    return this.breaker.snapshot(provider.kind, provider.name, this.outageUntil);
  }

  private currentProvider(): TelecomProvider {
    return this.configState.provider === 'RELIABLE' ? this.reliableProvider : this.chaosProvider;
  }

  private effectiveAnswerRate(): number {
    if (this.answerOverride && this.answerOverride.until > this.nowMs) return this.answerOverride.value;
    if (this.configState.scenario === 'D') {
      const phase = (this.nowMs % 120_000) / 120_000;
      return clamp(this.configState.answerRate + Math.sin(phase * Math.PI * 2) * 0.25, 0.1, 0.78);
    }
    return this.configState.answerRate;
  }

  private effectiveTalkConditions(): { setupMs: number; talkMs: number } {
    if (this.configState.scenario !== 'D') {
      return { setupMs: this.configState.averageSetupMs, talkMs: this.configState.averageTalkMs };
    }
    const phase = (this.nowMs % 150_000) / 150_000;
    return {
      setupMs: Math.round(this.configState.averageSetupMs * (0.75 + phase * 0.65)),
      talkMs: Math.round(this.configState.averageTalkMs * (0.65 + phase * 0.9)),
    };
  }

  private recordAnswerOutcome(answered: boolean): void {
    this.answerOutcomes.push(answered);
    if (this.answerOutcomes.length > 500) this.answerOutcomes.shift();
    const observation = answered ? 1 : 0;
    this.ewmaAnswerRate =
      this.configState.ewmaAlpha * observation + (1 - this.configState.ewmaAlpha) * this.ewmaAnswerRate;
  }

  private recordCallAnswerOutcome(call: DialerCall, answered: boolean): void {
    if (this.observedCallOutcomes.has(call.id)) return;
    this.observedCallOutcomes.add(call.id);
    this.recordAnswerOutcome(answered);
  }

  private recentAnswerRate(): number {
    const recent = this.answerOutcomes.slice(-30);
    if (recent.length === 0) return this.configState.answerRate;
    return recent.filter(Boolean).length / recent.length;
  }

  private calculateRates(context: PacingContext, provider: ProviderStatus): DialerRates {
    const actualSamples = this.answerOutcomes.length;
    const observed = actualSamples === 0 ? this.configState.answerRate : this.answerOutcomes.filter(Boolean).length / actualSamples;
    const denominator = Math.max(1, this.metricsState.callsInitiated);
    return {
      agentUtilization: round(
        this.metricsState.totalAgentMs === 0 ? 0 : this.metricsState.connectedAgentMs / this.metricsState.totalAgentMs,
      ),
      ewmaAnswerRate: round(this.ewmaAnswerRate),
      recentAnswerRate: round(context.recentAnswerRate),
      observedAnswerRate: round(observed),
      providerSuccessRate: provider.recentSuccessRate,
      completionRate: round(this.metricsState.callsCompleted / denominator),
      callsPerMinute: round(this.nowMs === 0 ? 0 : this.metricsState.callsInitiated / (this.nowMs / 60_000)),
    };
  }

  private accumulateAgentTime(durationMs: number): void {
    for (const agent of this.store.agents.values()) {
      if (agent.state === 'CONNECTED') this.metricsState.connectedAgentMs += durationMs;
      if (agent.state === 'AVAILABLE') this.metricsState.availableAgentMs += durationMs;
      this.metricsState.totalAgentMs += durationMs;
    }
  }

  private recordSafetyMetric(decision: SafetyDecision): void {
    if (decision.action === 'APPROVE') this.metricsState.safetyApprovals += 1;
    if (decision.action === 'REDUCE') this.metricsState.safetyReductions += 1;
    if (decision.action === 'REJECT') this.metricsState.safetyRejections += 1;
    if (decision.action === 'FALLBACK_PROGRESSIVE') this.metricsState.safetyFallbacks += 1;
  }

  private recordTrend(): void {
    if (!this.lastProposal || !this.lastDecision) return;
    const agentCounts = countAgents(this.store.agents.values());
    const callCounts = countCalls(this.store.calls.values());
    this.trendEntries.push({
      at: this.nowMs,
      availableAgents: agentCounts.AVAILABLE,
      connectedAgents: agentCounts.CONNECTED,
      ringingCalls: callCounts.RINGING,
      callsInitiated: this.metricsState.callsInitiated,
      callsConnected: this.metricsState.callsConnected,
      utilization: round(
        this.metricsState.totalAgentMs === 0 ? 0 : this.metricsState.connectedAgentMs / this.metricsState.totalAgentMs,
      ),
      ewmaAnswerRate: round(this.ewmaAnswerRate),
      providerHealth: this.providerStatus().healthScore,
      requested: this.lastProposal.requestedCalls,
      approved: this.lastDecision.approvedCalls,
      safetyBreaches: this.metricsState.safetyBreaches,
    });
    const limit = Math.max(60, this.configState.timelineLimit * 2);
    if (this.trendEntries.length > limit) this.trendEntries.splice(0, this.trendEntries.length - limit);
  }

  private auditInvariants(): InvariantSnapshot {
    const agentUse = new Map<string, number>();
    const borrowerUse = new Map<string, number>();
    let unboundActiveCalls = 0;
    let progressiveExposure = 0;
    const violations: string[] = [];
    for (const call of this.store.calls.values()) {
      if (isTerminalCallState(call.state)) continue;
      borrowerUse.set(call.borrowerId, (borrowerUse.get(call.borrowerId) ?? 0) + 1);
      if (call.agentId) agentUse.set(call.agentId, (agentUse.get(call.agentId) ?? 0) + 1);
      else unboundActiveCalls += 1;
      if (call.dialMode === 'PROGRESSIVE') {
        progressiveExposure += 1;
        if (!call.agentId) violations.push(`${call.id} is progressive but has no reserved agent`);
      }
      if ((call.state === 'ANSWERED' || call.state === 'CONNECTED') && !call.agentId) {
        violations.push(`${call.id} reached ${call.state} without an agent`);
      }
    }
    const duplicateAgentReservations = Array.from(agentUse.values()).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    const duplicateBorrowerReservations = Array.from(borrowerUse.values()).reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    );
    if (duplicateAgentReservations > 0) violations.push(`${duplicateAgentReservations} duplicate agent reservation(s)`);
    if (duplicateBorrowerReservations > 0) violations.push(`${duplicateBorrowerReservations} duplicate borrower reservation(s)`);
    if (this.metricsState.safetyBreaches > 0) violations.push(`${this.metricsState.safetyBreaches} unserved answered call(s)`);
    return {
      safe: violations.length === 0,
      violations,
      activeAgentReservations: agentUse.size,
      activeBorrowerReservations: borrowerUse.size,
      duplicateAgentReservations,
      duplicateBorrowerReservations,
      unboundActiveCalls,
      progressiveExposure,
      unservedAnswers: this.metricsState.unservedAnswers,
      safetyBreaches: this.metricsState.safetyBreaches,
      statement:
        'Progressive calls reserve agent+borrower atomically. Predictive prospects reserve the borrower, stay unbound before answer, and CAS an AVAILABLE agent before CONNECTED.',
    };
  }

  private workerSnapshots(): WorkerSnapshot[] {
    const owned = new Map<string, number>();
    for (const call of this.store.calls.values()) {
      if (!isTerminalCallState(call.state)) owned.set(call.workerId, (owned.get(call.workerId) ?? 0) + 1);
    }
    return Array.from(this.workers.values(), (worker) => ({ ...worker, ownedCalls: owned.get(worker.id) ?? 0 }));
  }

  private addBorrowers(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const id = `borrower-${++this.borrowerSequence}`;
      this.store.addBorrower({
        id,
        state: 'READY',
        version: 0,
        priority: this.random.integer(1, 100),
        attempts: 0,
      });
    }
  }

  private expireRuntimeOverrides(): void {
    if (this.outageUntil !== undefined && this.nowMs >= this.outageUntil) this.outageUntil = undefined;
    if (this.latencyOverride && this.nowMs >= this.latencyOverride.until) this.latencyOverride = undefined;
    if (this.answerOverride && this.nowMs >= this.answerOverride.until) this.answerOverride = undefined;
    if (this.webhookLossOverride && this.nowMs >= this.webhookLossOverride.until) this.webhookLossOverride = undefined;
  }

  private log(
    category: TimelineEntry['category'],
    severity: TimelineEntry['severity'],
    message: string,
    call?: DialerCall,
    agent?: Agent,
  ): void {
    this.timelineEntries.push({
      id: ++this.timelineSequence,
      at: this.nowMs,
      category,
      severity,
      message,
      callId: call?.id,
      agentId: agent?.id ?? call?.agentId,
    });
    if (this.timelineEntries.length > this.configState.timelineLimit) {
      this.timelineEntries.splice(0, this.timelineEntries.length - this.configState.timelineLimit);
    }
  }
}

function mergeConfig(base: SimulatorConfig, input: SimulatorConfigInput): SimulatorConfig {
  const merged: SimulatorConfig = {
    ...base,
    ...input,
    safety: { ...base.safety, ...input.safety, deterministicReservation: true },
    circuitBreaker: { ...base.circuitBreaker, ...input.circuitBreaker },
    chaosProvider: { ...base.chaosProvider, ...input.chaosProvider },
  };
  merged.agentCount = integerAtLeast(merged.agentCount, 1);
  merged.borrowerCount = integerAtLeast(merged.borrowerCount, 0);
  merged.workerCount = integerAtLeast(merged.workerCount, 1);
  merged.tickMs = integerAtLeast(merged.tickMs, 1);
  merged.leaseMs = integerAtLeast(merged.leaseMs, 1);
  merged.wrapUpMs = integerAtLeast(merged.wrapUpMs, 0);
  merged.answerRate = clamp(merged.answerRate, 0, 1);
  merged.averageSetupMs = integerAtLeast(merged.averageSetupMs, 1);
  merged.averageTalkMs = integerAtLeast(merged.averageTalkMs, 1);
  merged.ewmaAlpha = clamp(merged.ewmaAlpha, 0.001, 1);
  merged.initialHistoricalSamples = integerAtLeast(merged.initialHistoricalSamples, 0);
  merged.maxBatchSize = integerAtLeast(merged.maxBatchSize, 1);
  merged.minAnswerRate = clamp(merged.minAnswerRate, 0.001, 0.99);
  merged.confidenceZ = Math.max(0, merged.confidenceZ);
  merged.timelineLimit = integerAtLeast(merged.timelineLimit, 20);
  merged.safety.maxProviderInFlight = integerAtLeast(merged.safety.maxProviderInFlight, 1);
  merged.safety.progressiveFallbackBatch = integerAtLeast(merged.safety.progressiveFallbackBatch, 1);
  merged.safety.minHistoricalSamples = integerAtLeast(merged.safety.minHistoricalSamples, 0);
  merged.safety.minProviderHealth = clamp(merged.safety.minProviderHealth, 0, 1);
  return merged;
}

function emptyMetrics(): DialerMetrics {
  return {
    reservations: 0,
    casConflicts: 0,
    callsInitiated: 0,
    callsAnswered: 0,
    callsConnected: 0,
    callsCompleted: 0,
    callsFailed: 0,
    callsCancelled: 0,
    providerRequests: 0,
    providerFailures: 0,
    duplicateEventsIgnored: 0,
    outOfOrderEventsIgnored: 0,
    terminalEventsIgnored: 0,
    unknownEventsIgnored: 0,
    unservedAnswers: 0,
    safetyBreaches: 0,
    leasesRecovered: 0,
    workerCrashes: 0,
    safetyApprovals: 0,
    safetyReductions: 0,
    safetyRejections: 0,
    safetyFallbacks: 0,
    peakProviderInFlight: 0,
    connectedAgentMs: 0,
    availableAgentMs: 0,
    totalAgentMs: 0,
  };
}

function countAgents(agents: Iterable<Agent>): Record<AgentState, number> {
  const counts: Record<AgentState, number> = {
    OFFLINE: 0,
    AVAILABLE: 0,
    RESERVED: 0,
    DIALING: 0,
    CONNECTED: 0,
    WRAP_UP: 0,
    PAUSED: 0,
  };
  for (const agent of agents) counts[agent.state] += 1;
  return counts;
}

function countBorrowers(borrowers: Iterable<Borrower>): Record<BorrowerState, number> {
  const counts: Record<BorrowerState, number> = { READY: 0, RESERVED: 0, IN_CALL: 0, DONE: 0 };
  for (const borrower of borrowers) counts[borrower.state] += 1;
  return counts;
}

function countCalls(calls: Iterable<DialerCall>): Record<CallState, number> {
  const counts: Record<CallState, number> = {
    QUEUED: 0,
    RESERVED: 0,
    INITIATED: 0,
    RINGING: 0,
    ANSWERED: 0,
    CONNECTED: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  for (const call of calls) counts[call.state] += 1;
  return counts;
}

function cloneAgent(agent: Agent): Agent {
  return { ...agent };
}

function cloneBorrower(borrower: Borrower): Borrower {
  return { ...borrower };
}

function cloneCall(call: DialerCall): CallSnapshot {
  const { processedEventIds, transitions, ...rest } = call;
  return {
    ...rest,
    processedEventCount: processedEventIds.size,
    transitions: transitions.map((transition) => ({ ...transition })),
  };
}

function cloneConfig(config: SimulatorConfig): SimulatorConfig {
  return {
    ...config,
    safety: { ...config.safety },
    circuitBreaker: { ...config.circuitBreaker },
    chaosProvider: { ...config.chaosProvider },
  };
}

function cloneProposal(proposal: PaceProposal): PaceProposal {
  return { ...proposal, factors: { ...proposal.factors } };
}

function compareScheduledEvents(left: ScheduledProviderEvent, right: ScheduledProviderEvent): number {
  return left.dueAt - right.dueAt || left.sequence - right.sequence;
}

function integerAtLeast(value: number, minimum: number): number {
  return Math.max(minimum, Math.floor(Number.isFinite(value) ? value : minimum));
}

function isAgentState(value: unknown): value is AgentState {
  return ['OFFLINE', 'AVAILABLE', 'RESERVED', 'DIALING', 'CONNECTED', 'WRAP_UP', 'PAUSED'].includes(String(value));
}

function normalizeScenarioId(value: ScenarioId | string): ScenarioId {
  const normalized = String(value).trim().toUpperCase().replace(/[ -]+/g, '_');
  const aliases: Record<string, ScenarioId> = {
    A: 'A',
    B: 'B',
    C: 'C',
    D: 'D',
    CRASH: 'CRASH',
    WORKER_CRASH: 'CRASH',
    OUTAGE: 'OUTAGE',
    PROVIDER_OUTAGE: 'OUTAGE',
    AGENT_DROP: 'AGENT_DROP',
    CHAOS: 'OUT_OF_ORDER_EVENTS',
    DUPLICATES: 'DUPLICATE_EVENTS',
    DUPLICATE_EVENTS: 'DUPLICATE_EVENTS',
    OUT_OF_ORDER: 'OUT_OF_ORDER_EVENTS',
    OUT_OF_ORDER_EVENTS: 'OUT_OF_ORDER_EVENTS',
  };
  return aliases[normalized] ?? 'A';
}
