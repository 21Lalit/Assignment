import { clamp, round } from './random';
import type { PaceProposal, PacingContext, SafetyConfig, SafetyDecision } from './types';

export interface PacingEngine {
  propose(context: PacingContext): PaceProposal;
}

export class ProgressivePacingEngine implements PacingEngine {
  propose(context: PacingContext): PaceProposal {
    const requestedCalls = Math.max(
      0,
      Math.min(context.availableAgents, context.readyBorrowers, context.providerHeadroom, context.maxBatchSize),
    );
    return {
      mode: 'PROGRESSIVE',
      requestedCalls,
      generatedAt: context.now,
      formula: 'min(available agents, ready borrowers, provider headroom, batch limit)',
      explanation: `${context.availableAgents} agents are immediately reservable; progressive mode requests ${requestedCalls} one-to-one calls.`,
      factors: {
        availableCapacity: context.availableAgents,
        releaseForecast: 0,
        expectedAnswersInFlight: 0,
        uncertaintyBuffer: 0,
        effectiveAnswerRate: context.ewmaAnswerRate,
        behaviorMultiplier: 1,
        providerMultiplier: context.providerHealth,
        providerHeadroom: context.providerHeadroom,
      },
    };
  }
}

/**
 * Explainable advisory pacing. This object has no provider or allocator reference,
 * so its output can only become calls after SafetyController and CallAllocator.
 */
export class PredictivePacingEngine implements PacingEngine {
  propose(context: PacingContext): PaceProposal {
    const answerRate = clamp(context.ewmaAnswerRate, context.minAnswerRate, 0.99);
    const recentRate = context.historicalSamples > 0 ? context.recentAnswerRate : answerRate;
    const behaviorMultiplier = clamp(recentRate / answerRate, 0.65, 1.15);
    const providerMultiplier = clamp(context.providerHealth, 0.2, 1);
    const setupToTalkRatio = context.averageTalkMs > 0 ? context.averageSetupMs / context.averageTalkMs : 0;
    const releaseForecast = context.connectedAgents * clamp(setupToTalkRatio, 0, 0.5);

    // ANSWERED calls consume one full capacity unit; RINGING and early setup calls
    // consume probabilistic capacity according to the EWMA answer rate.
    const probabilisticExposure = context.ringingCalls + context.initiatedCalls * 0.65;
    const expectedAnswersInFlight = context.answeredCalls + probabilisticExposure * answerRate;
    const uncertaintyBuffer =
      context.confidenceZ * Math.sqrt(Math.max(0, probabilisticExposure * answerRate * (1 - answerRate)));
    const answerCapacity = context.availableAgents + releaseForecast;
    const unservedAnswerCapacity = Math.max(0, answerCapacity - expectedAnswersInFlight - uncertaintyBuffer);
    const rawAttempts = unservedAnswerCapacity / answerRate;
    const adjustedAttempts = rawAttempts * behaviorMultiplier * providerMultiplier;
    const requestedCalls = Math.max(
      0,
      Math.min(context.maxBatchSize, context.readyBorrowers, context.providerHeadroom, Math.floor(adjustedAttempts)),
    );

    const factors = {
      availableCapacity: round(context.availableAgents),
      releaseForecast: round(releaseForecast),
      expectedAnswersInFlight: round(expectedAnswersInFlight),
      uncertaintyBuffer: round(uncertaintyBuffer),
      effectiveAnswerRate: round(answerRate),
      behaviorMultiplier: round(behaviorMultiplier),
      providerMultiplier: round(providerMultiplier),
      providerHeadroom: context.providerHeadroom,
    };
    return {
      mode: 'PREDICTIVE',
      requestedCalls,
      generatedAt: context.now,
      formula:
        'floor(max(0, available + releaseForecast - expectedAnswersInFlight - z*sqrt(n*p*(1-p))) / p * recentBehavior * providerHealth)',
      explanation:
        `Capacity ${round(answerCapacity)} minus expected in-flight answers ${round(expectedAnswersInFlight)} ` +
        `and uncertainty ${round(uncertaintyBuffer)}, divided by EWMA p=${round(answerRate)}, ` +
        `then adjusted by recent behavior ${round(behaviorMultiplier)} and provider health ${round(providerMultiplier)}.`,
      factors,
    };
  }
}

/** The non-bypassable gate between every pacing proposal and allocation. */
export class SafetyController {
  constructor(private readonly config: SafetyConfig) {}

  evaluate(proposal: PaceProposal, context: PacingContext): SafetyDecision {
    const absoluteNewLimit = Math.max(
      0,
      Math.min(context.readyBorrowers, context.providerHeadroom, context.maxBatchSize),
    );
    const hardCapacity =
      proposal.mode === 'PROGRESSIVE'
        ? Math.min(absoluteNewLimit, context.availableAgents)
        : predictiveAttemptCapacity(context, absoluteNewLimit);
    const safetyAnswerRate = conservativeAnswerProbability(context);
    const predictedAnswerUpperBound = binomialAnswerUpperBound(
      context.unassignedInFlightCalls + hardCapacity,
      safetyAnswerRate,
      context.confidenceZ,
    );
    const base = {
      requestedCalls: proposal.requestedCalls,
      hardCapacity,
      predictedAnswerUpperBound: round(predictedAnswerUpperBound),
      safetyAnswerRate: round(safetyAnswerRate),
      decidedAt: context.now,
      invariant:
        proposal.mode === 'PROGRESSIVE'
          ? 'approved calls <= atomically reservable AVAILABLE agents'
          : 'upper-confidence answered exposure <= AVAILABLE agents; every answer uses atomic agent CAS before CONNECTED',
    };

    if (context.circuitState === 'OPEN') {
      return {
        ...base,
        action: 'REJECT',
        approvedCalls: 0,
        reasonCode: 'CIRCUIT_OPEN',
        explanation: 'Provider circuit is open; new calls are blocked while existing calls remain recoverable.',
      };
    }
    const progressiveCapacity = Math.min(
      context.availableAgents,
      context.readyBorrowers,
      context.providerHeadroom,
      this.config.progressiveFallbackBatch,
    );
    if (
      proposal.mode === 'PREDICTIVE' &&
      context.historicalSamples < this.config.minHistoricalSamples &&
      progressiveCapacity > 0
    ) {
      const approvedCalls = progressiveCapacity;
      return {
        ...base,
        action: 'FALLBACK_PROGRESSIVE',
        approvedCalls,
        reasonCode: 'INSUFFICIENT_HISTORY',
        explanation: `Only ${context.historicalSamples} observations are available; using a ${approvedCalls}-call progressive fallback.`,
      };
    }
    if (
      proposal.mode === 'PREDICTIVE' &&
      (context.providerHealth < this.config.minProviderHealth || context.circuitState === 'HALF_OPEN') &&
      progressiveCapacity > 0
    ) {
      const approvedCalls = progressiveCapacity;
      return {
        ...base,
        action: 'FALLBACK_PROGRESSIVE',
        approvedCalls,
        reasonCode: 'PROVIDER_DEGRADED',
        explanation: `Provider health ${round(context.providerHealth)} is degraded; allowing only ${approvedCalls} progressive probe call(s).`,
      };
    }
    if (hardCapacity === 0) {
      return {
        ...base,
        action: 'REJECT',
        approvedCalls: 0,
        reasonCode: 'NO_CAPACITY',
        explanation: 'No simultaneously safe agent, borrower, and provider capacity exists.',
      };
    }
    if (proposal.requestedCalls <= 0) {
      return {
        ...base,
        action: 'REJECT',
        approvedCalls: 0,
        reasonCode: 'NO_REQUEST',
        explanation: 'The pacing engine found no safe demand to start.',
      };
    }
    if (proposal.requestedCalls > hardCapacity) {
      return {
        ...base,
        action: 'REDUCE',
        approvedCalls: hardCapacity,
        reasonCode: 'HARD_CAPACITY',
        explanation: `Pacing requested ${proposal.requestedCalls}; safety reduced it to ${hardCapacity} atomically reservable calls.`,
      };
    }
    return {
      ...base,
      action: 'APPROVE',
      approvedCalls: proposal.requestedCalls,
      reasonCode: 'WITHIN_LIMITS',
      explanation: `All ${proposal.requestedCalls} calls fit current reservation and provider capacity.`,
    };
  }
}

export function binomialAnswerUpperBound(attempts: number, probability: number, z: number): number {
  if (attempts <= 0) return 0;
  const p = clamp(probability, 0, 1);
  return attempts * p + Math.max(0, z) * Math.sqrt(attempts * p * (1 - p));
}

/** Largest additional prospecting batch whose conservative answer bound fits live capacity. */
export function predictiveAttemptCapacity(context: PacingContext, maximumAdditional: number): number {
  const p = conservativeAnswerProbability(context);
  const current = Math.max(0, context.unassignedInFlightCalls);
  if (binomialAnswerUpperBound(current, p, context.confidenceZ) > context.availableAgents) return 0;

  let low = 0;
  let high = Math.max(0, Math.floor(maximumAdditional));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bound = binomialAnswerUpperBound(current + middle, p, context.confidenceZ);
    if (bound <= context.availableAgents) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Upper-confidence estimate of p, guarding against a temporarily optimistic EWMA. */
export function conservativeAnswerProbability(context: PacingContext): number {
  const estimate = clamp(
    Math.max(context.ewmaAnswerRate, context.recentAnswerRate),
    context.minAnswerRate,
    0.99,
  );
  const samples = Math.max(1, context.historicalSamples);
  const estimationMargin = context.confidenceZ * Math.sqrt((estimate * (1 - estimate)) / samples);
  return clamp(estimate + estimationMargin, context.minAnswerRate, 0.99);
}
