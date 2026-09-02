import { describe, expect, it } from 'vitest';
import { SmartDialerSimulator } from './simulator';

describe('SmartDialerSimulator', () => {
  it('keeps progressive reservations bound to agents', () => {
    const simulator = new SmartDialerSimulator({
      mode: 'PROGRESSIVE',
      scenario: 'B',
      seed: 'progressive-test',
      agentCount: 12,
      borrowerCount: 60,
    });

    const snapshot = simulator.run(40);

    expect(snapshot.invariants.safe).toBe(true);
    expect(snapshot.invariants.progressiveExposure).toBeGreaterThanOrEqual(0);
    expect(snapshot.invariants.violations).toEqual([]);
  });

  it('recovers leases after a worker crash', () => {
    const simulator = new SmartDialerSimulator({
      scenario: 'CRASH',
      seed: 'crash-test',
      leaseMs: 2_000,
    });

    simulator.run(2);
    simulator.inject({ type: 'WORKER_CRASH', workerId: 'worker-1', recoverAfterMs: 4_000 });
    const snapshot = simulator.run(10);

    expect(snapshot.metrics.workerCrashes).toBe(1);
    expect(snapshot.metrics.leasesRecovered).toBeGreaterThan(0);
    expect(snapshot.invariants.safe).toBe(true);
  });

  it('opens the circuit during a provider outage and blocks new calls', () => {
    const simulator = new SmartDialerSimulator({
      scenario: 'OUTAGE',
      seed: 'outage-test',
    });

    simulator.inject({ type: 'PROVIDER_OUTAGE', durationMs: 15_000 });
    const snapshot = simulator.step();

    expect(snapshot.provider.circuitState).toBe('OPEN');
    expect(snapshot.safety.reasonCode).toBe('CIRCUIT_OPEN');
    expect(snapshot.safety.approvedCalls).toBe(0);
  });

  it('clears a manually injected outage without advancing simulated time', () => {
    const simulator = new SmartDialerSimulator({ scenario: 'B', seed: 'clear-outage-test' });
    simulator.inject({ type: 'PROVIDER_OUTAGE', durationMs: 3_600_000 });
    const beforeClear = simulator.snapshot();
    const recovered = simulator.inject({ type: 'CLEAR_RUNTIME_OVERRIDE', override: 'PROVIDER_OUTAGE' });

    expect(recovered.elapsedMs).toBe(beforeClear.elapsedMs);
    expect(recovered.provider.circuitState).toBe('CLOSED');
    expect(recovered.safety.approvedCalls).toBeGreaterThan(0);
  });
});
