import type { ScenarioDefinition, ScenarioId } from './types';

export const SCENARIOS: Readonly<Record<ScenarioId, ScenarioDefinition>> = {
  A: {
    id: 'A',
    title: 'Low answer / long conversation',
    description: '20% answer rate and 120 second average talk time.',
    config: { answerRate: 0.2, averageSetupMs: 5_000, averageTalkMs: 120_000, provider: 'RELIABLE' },
  },
  B: {
    id: 'B',
    title: 'Balanced campaign',
    description: '50% answer rate and 90 second average talk time.',
    config: { answerRate: 0.5, averageSetupMs: 4_000, averageTalkMs: 90_000, provider: 'RELIABLE' },
  },
  C: {
    id: 'C',
    title: 'High answer / long conversation',
    description: '70% answer rate and 180 second average talk time.',
    config: { answerRate: 0.7, averageSetupMs: 6_000, averageTalkMs: 180_000, provider: 'RELIABLE' },
  },
  D: {
    id: 'D',
    title: 'Changing campaign behaviour',
    description: 'Answer rate and talk time change deterministically throughout the run.',
    config: { answerRate: 0.38, averageSetupMs: 4_500, averageTalkMs: 90_000, provider: 'CHAOS' },
  },
  CRASH: {
    id: 'CRASH',
    title: 'Worker crash and lease recovery',
    description: 'A dialer worker crashes after initiation; an expired lease is adopted by another worker.',
    config: { answerRate: 0.45, leaseMs: 4_000, provider: 'RELIABLE', workerCount: 3 },
  },
  OUTAGE: {
    id: 'OUTAGE',
    title: 'Provider outage and circuit breaker',
    description: 'The provider stops accepting calls, opens the circuit, and later permits a half-open probe.',
    config: { answerRate: 0.4, provider: 'CHAOS' },
  },
  AGENT_DROP: {
    id: 'AGENT_DROP',
    title: 'Sudden capacity drop',
    description: '40 of 100 available agents disappear while calls are in setup.',
    config: { agentCount: 100, borrowerCount: 600, answerRate: 0.35, provider: 'RELIABLE' },
  },
  DUPLICATE_EVENTS: {
    id: 'DUPLICATE_EVENTS',
    title: 'Duplicate webhooks',
    description: 'The chaos provider repeats most events; the reducer applies each event identity once.',
    config: { provider: 'CHAOS', chaosProvider: { duplicateRate: 0.9, outOfOrderRate: 0 } },
  },
  OUT_OF_ORDER_EVENTS: {
    id: 'OUT_OF_ORDER_EVENTS',
    title: 'Out-of-order webhooks',
    description: 'The chaos provider deliberately delivers later lifecycle events first.',
    config: { provider: 'CHAOS', chaosProvider: { duplicateRate: 0.15, outOfOrderRate: 0.9 } },
  },
};

export function getScenario(id: ScenarioId): ScenarioDefinition {
  return SCENARIOS[id];
}
