import { describe, expect, it } from 'vitest';
import {
  PredictivePacingEngine,
  ProgressivePacingEngine,
  SafetyController,
  predictiveAttemptCapacity,
} from './pacing';
import type { PacingContext } from './types';

function context(overrides: Partial<PacingContext> = {}): PacingContext {
  return {
    mode: 'PREDICTIVE',
    now: 0,
    availableAgents: 20,
    reservedAgents: 0,
    dialingAgents: 0,
    connectedAgents: 5,
    wrapUpAgents: 0,
    readyBorrowers: 200,
    queuedCalls: 0,
    initiatedCalls: 3,
    ringingCalls: 2,
    answeredCalls: 1,
    connectedCalls: 5,
    providerInFlight: 6,
    unassignedInFlightCalls: 2,
    providerHeadroom: 100,
    providerHealth: 0.95,
    circuitState: 'CLOSED',
    ewmaAnswerRate: 0.35,
    recentAnswerRate: 0.38,
    historicalSamples: 80,
    averageSetupMs: 4_000,
    averageTalkMs: 90_000,
    maxBatchSize: 100,
    minAnswerRate: 0.08,
    confidenceZ: 3.5,
    ...overrides,
  };
}

describe('pacing engines', () => {
  it('caps progressive requests at immediately reservable capacity', () => {
    const proposal = new ProgressivePacingEngine().propose(
      context({
        mode: 'PROGRESSIVE',
        availableAgents: 7,
        readyBorrowers: 9,
        providerHeadroom: 6,
        maxBatchSize: 10,
      }),
    );

    expect(proposal.mode).toBe('PROGRESSIVE');
    expect(proposal.requestedCalls).toBe(6);
  });

  it('keeps predictive requests inside borrower and provider bounds', () => {
    const proposal = new PredictivePacingEngine().propose(
      context({
        availableAgents: 30,
        readyBorrowers: 11,
        providerHeadroom: 8,
      }),
    );

    expect(proposal.mode).toBe('PREDICTIVE');
    expect(proposal.requestedCalls).toBeLessThanOrEqual(8);
    expect(proposal.requestedCalls).toBeLessThanOrEqual(11);
  });

  it('falls back to progressive probing when predictive history is sparse', () => {
    const proposal = new PredictivePacingEngine().propose(context({ historicalSamples: 4 }));
    const decision = new SafetyController({
      minProviderHealth: 0.72,
      minHistoricalSamples: 20,
      progressiveFallbackBatch: 1,
      maxProviderInFlight: 500,
      deterministicReservation: true,
    }).evaluate(proposal, context({ historicalSamples: 4 }));

    expect(decision.action).toBe('FALLBACK_PROGRESSIVE');
    expect(decision.approvedCalls).toBe(1);
    expect(decision.reasonCode).toBe('INSUFFICIENT_HISTORY');
  });

  it('reduces predictive attempt capacity when unassigned exposure is already high', () => {
    const base = context({ availableAgents: 10, unassignedInFlightCalls: 0 });
    const stressed = context({ availableAgents: 10, unassignedInFlightCalls: 8 });

    expect(predictiveAttemptCapacity(stressed, 20)).toBeLessThan(predictiveAttemptCapacity(base, 20));
  });
});
