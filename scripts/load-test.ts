import { SmartDialerSimulator } from '../src/core';

interface LoadCase {
  label: string;
  agentCount: number;
  borrowerCount: number;
  steps: number;
  mode: 'PROGRESSIVE' | 'PREDICTIVE';
  maxBatchSize?: number;
}

const CASES: readonly LoadCase[] = [
  { label: '100 agents', agentCount: 100, borrowerCount: 1_500, steps: 120, mode: 'PREDICTIVE' },
  { label: '1,000 agents', agentCount: 1_000, borrowerCount: 15_000, steps: 120, mode: 'PREDICTIVE' },
  // A bounded smoke run proves the 10,000-agent path without retaining an
  // unrealistic browser-sized population of every call/event in memory.
  { label: '10,000 agents', agentCount: 10_000, borrowerCount: 10_000, steps: 3, mode: 'PROGRESSIVE', maxBatchSize: 100 },
] as const;

for (const testCase of CASES) {
  const startedAt = performance.now();
  const simulator = new SmartDialerSimulator({
    seed: `load:${testCase.agentCount}`,
    mode: testCase.mode,
    scenario: 'B',
    agentCount: testCase.agentCount,
    borrowerCount: testCase.borrowerCount,
    workerCount: Math.max(3, Math.ceil(testCase.agentCount / 500)),
    maxBatchSize: testCase.maxBatchSize ?? Math.max(100, Math.ceil(testCase.agentCount / 8)),
    safety: {
      maxProviderInFlight: Math.max(500, testCase.agentCount * 3),
    },
  });

  const snapshot = simulator.run(testCase.steps);
  const elapsedMs = performance.now() - startedAt;
  if (!snapshot.invariants.safe || snapshot.metrics.safetyBreaches > 0) {
    throw new Error(`${testCase.label} violated a safety invariant during the load run.`);
  }
  const processedCalls =
    snapshot.metrics.callsCompleted +
    snapshot.metrics.callsFailed +
    snapshot.metrics.callsCancelled +
    snapshot.callCounts.INITIATED +
    snapshot.callCounts.RINGING +
    snapshot.callCounts.ANSWERED +
    snapshot.callCounts.CONNECTED;

  console.log(
    JSON.stringify(
      {
        case: testCase.label,
        mode: testCase.mode,
        simulatedSeconds: snapshot.elapsedMs / 1_000,
        wallClockMs: Math.round(elapsedMs),
        agentsAvailable: snapshot.agentCounts.AVAILABLE,
        agentsConnected: snapshot.agentCounts.CONNECTED,
        processedCalls,
        callsInitiated: snapshot.metrics.callsInitiated,
        callsCompleted: snapshot.metrics.callsCompleted,
        providerFailures: snapshot.metrics.providerFailures,
        casConflicts: snapshot.metrics.casConflicts,
        utilization: snapshot.rates.agentUtilization,
        invariantsSafe: snapshot.invariants.safe,
        safetyBreaches: snapshot.metrics.safetyBreaches,
        unservedAnswers: snapshot.metrics.unservedAnswers,
      },
      null,
      2,
    ),
  );
}
