import { clamp, round, SeededRandom } from './random';
import type {
  ChaosProviderConfig,
  CircuitBreakerConfig,
  CircuitState,
  ProviderDialRequest,
  ProviderInitiation,
  ProviderKind,
  ProviderStatus,
  ScheduledProviderEvent,
} from './types';

export interface TelecomProvider {
  readonly kind: ProviderKind;
  readonly name: string;
  initiate(request: ProviderDialRequest, now: number, random: SeededRandom): ProviderInitiation;
  reset(): void;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private outcomes: boolean[] = [];
  private latencies: number[] = [];
  private consecutiveFailures = 0;
  private openUntil?: number;
  private halfOpenSuccessCount = 0;
  private halfOpenProbeActive = false;
  private requests = 0;
  private failures = 0;

  constructor(private readonly config: CircuitBreakerConfig) {}

  reset(): void {
    this.state = 'CLOSED';
    this.outcomes = [];
    this.latencies = [];
    this.consecutiveFailures = 0;
    this.openUntil = undefined;
    this.halfOpenSuccessCount = 0;
    this.halfOpenProbeActive = false;
    this.requests = 0;
    this.failures = 0;
  }

  tick(now: number): void {
    if (this.state === 'OPEN' && this.openUntil !== undefined && now >= this.openUntil) {
      this.state = 'HALF_OPEN';
      this.halfOpenProbeActive = false;
      this.halfOpenSuccessCount = 0;
    }
  }

  allowRequest(now: number): boolean {
    this.tick(now);
    if (this.state === 'OPEN') return false;
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenProbeActive) return false;
      this.halfOpenProbeActive = true;
    }
    this.requests += 1;
    return true;
  }

  recordSuccess(latencyMs: number): void {
    this.pushOutcome(true, latencyMs);
    this.consecutiveFailures = 0;
    if (this.state === 'HALF_OPEN') {
      this.halfOpenProbeActive = false;
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.config.halfOpenSuccesses) {
        this.state = 'CLOSED';
        this.openUntil = undefined;
        this.halfOpenSuccessCount = 0;
      }
    }
  }

  recordFailure(now: number, latencyMs = 0): void {
    this.pushOutcome(false, latencyMs);
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.halfOpenProbeActive = false;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.config.failureThreshold) {
      this.forceOpen(now, this.config.openDurationMs);
    }
  }

  forceOpen(now: number, durationMs = this.config.openDurationMs): void {
    this.state = 'OPEN';
    this.openUntil = now + Math.max(1, durationMs);
    this.halfOpenProbeActive = false;
    this.halfOpenSuccessCount = 0;
  }

  snapshot(kind: ProviderKind, name: string, outageUntil?: number): ProviderStatus {
    const successRate = this.outcomes.length === 0
      ? 1
      : this.outcomes.filter(Boolean).length / this.outcomes.length;
    const averageLatencyMs = this.latencies.length === 0
      ? 0
      : this.latencies.reduce((sum, value) => sum + value, 0) / this.latencies.length;
    const latencyMultiplier = clamp(1 - Math.max(0, averageLatencyMs - 500) / 15_000, 0.55, 1);
    const circuitMultiplier = this.state === 'OPEN' ? 0 : this.state === 'HALF_OPEN' ? 0.35 : 1;
    return {
      kind,
      name,
      circuitState: this.state,
      healthScore: round(successRate * latencyMultiplier * circuitMultiplier),
      recentSuccessRate: round(successRate),
      averageLatencyMs: round(averageLatencyMs),
      consecutiveFailures: this.consecutiveFailures,
      openUntil: this.openUntil,
      outageUntil,
      requests: this.requests,
      failures: this.failures,
    };
  }

  private pushOutcome(success: boolean, latencyMs: number): void {
    this.outcomes.push(success);
    this.latencies.push(Math.max(0, latencyMs));
    if (this.outcomes.length > this.config.windowSize) this.outcomes.shift();
    if (this.latencies.length > this.config.windowSize) this.latencies.shift();
  }
}

abstract class BaseMockProvider implements TelecomProvider {
  abstract readonly kind: ProviderKind;
  abstract readonly name: string;
  protected sequence = 0;
  protected readonly idempotency = new Map<string, ProviderInitiation>();

  abstract initiate(request: ProviderDialRequest, now: number, random: SeededRandom): ProviderInitiation;

  reset(): void {
    this.sequence = 0;
    this.idempotency.clear();
  }

  protected replay(key: string): ProviderInitiation | undefined {
    const previous = this.idempotency.get(key);
    if (!previous) return undefined;
    return {
      ...previous,
      replayed: true,
      events: previous.events.map((event) => ({ ...event })),
    };
  }

  protected remember(key: string, result: ProviderInitiation): ProviderInitiation {
    this.idempotency.set(key, {
      ...result,
      events: result.events.map((event) => ({ ...event })),
    });
    return result;
  }

  protected providerCallId(): string {
    return `${this.kind.toLowerCase()}-${++this.sequence}`;
  }
}

export class ReliableMockProvider extends BaseMockProvider {
  readonly kind = 'RELIABLE' as const;
  readonly name = 'Saarthi Reliable Voice';

  initiate(request: ProviderDialRequest, now: number, random: SeededRandom): ProviderInitiation {
    const replay = this.replay(request.idempotencyKey);
    if (replay) return replay;
    const providerCallId = this.providerCallId();
    const latencyMs = Math.round(random.between(90, 240));
    const setupMs = Math.max(350, Math.round(request.averageSetupMs * random.between(0.72, 1.28)));
    const talkMs = Math.max(500, Math.round(request.averageTalkMs * random.between(0.72, 1.28)));
    const answered = random.chance(request.answerProbability);
    const events: Omit<ScheduledProviderEvent, 'sequence'>[] = [
      eventOf(request.callId, providerCallId, 'RINGING', now + latencyMs, now + latencyMs),
    ];
    if (answered) {
      events.push(eventOf(request.callId, providerCallId, 'ANSWERED', now + setupMs, now + setupMs));
      events.push(eventOf(request.callId, providerCallId, 'COMPLETED', now + setupMs + talkMs, now + setupMs + talkMs));
    } else {
      events.push(eventOf(request.callId, providerCallId, 'FAILED', now + setupMs, now + setupMs, 'NO_ANSWER'));
    }
    return this.remember(request.idempotencyKey, {
      accepted: true,
      providerCallId,
      latencyMs,
      events,
    });
  }
}

export class ChaosMockProvider extends BaseMockProvider {
  readonly kind = 'CHAOS' as const;
  readonly name = 'Drishti Chaos Voice';

  constructor(private readonly config: ChaosProviderConfig) {
    super();
  }

  initiate(request: ProviderDialRequest, now: number, random: SeededRandom): ProviderInitiation {
    const replay = this.replay(request.idempotencyKey);
    if (replay) return replay;
    const latencyMs = Math.round(random.between(this.config.minimumLatencyMs, this.config.maximumLatencyMs));
    if (random.chance(this.config.timeoutRate)) {
      return this.remember(request.idempotencyKey, {
        accepted: false,
        latencyMs,
        events: [],
        error: 'PROVIDER_TIMEOUT',
      });
    }
    if (random.chance(this.config.failureRate)) {
      return this.remember(request.idempotencyKey, {
        accepted: false,
        latencyMs,
        events: [],
        error: 'PROVIDER_REJECTED',
      });
    }

    const providerCallId = this.providerCallId();
    const setupMs = Math.max(latencyMs + 100, Math.round(request.averageSetupMs * random.between(0.65, 1.65)));
    const talkMs = Math.max(500, Math.round(request.averageTalkMs * random.between(0.55, 1.55)));
    const answered = random.chance(request.answerProbability);
    const ringing = eventOf(request.callId, providerCallId, 'RINGING', now + latencyMs, now + latencyMs);
    const events: Omit<ScheduledProviderEvent, 'sequence'>[] = [ringing];
    if (answered) {
      const answer = eventOf(request.callId, providerCallId, 'ANSWERED', now + setupMs, now + setupMs);
      const complete = eventOf(
        request.callId,
        providerCallId,
        'COMPLETED',
        now + setupMs + talkMs,
        now + setupMs + talkMs,
      );
      events.push(answer, complete);
      if (random.chance(this.config.outOfOrderRate)) {
        if (random.chance(0.5)) ringing.dueAt = Math.max(now + 1, answer.dueAt + Math.round(latencyMs * 0.25));
        else complete.dueAt = Math.max(now + 1, answer.dueAt - Math.round(latencyMs * 0.5));
      }
    } else {
      events.push(eventOf(request.callId, providerCallId, 'FAILED', now + setupMs, now + setupMs, 'NO_ANSWER'));
    }

    const originals = [...events];
    for (const original of originals) {
      if (random.chance(this.config.duplicateRate)) {
        events.push({ ...original, dueAt: original.dueAt + Math.round(random.between(1, 200)) });
      }
    }
    return this.remember(request.idempotencyKey, {
      accepted: true,
      providerCallId,
      latencyMs,
      events,
    });
  }
}

function eventOf(
  callId: string,
  providerCallId: string,
  type: ScheduledProviderEvent['type'],
  occurredAt: number,
  dueAt: number,
  reason?: string,
): Omit<ScheduledProviderEvent, 'sequence'> {
  return {
    id: `${providerCallId}:${type}`,
    callId,
    providerCallId,
    type,
    occurredAt,
    dueAt,
    reason,
  };
}
