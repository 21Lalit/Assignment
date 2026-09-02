import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getScenario,
  SmartDialerSimulator,
  type DialMode,
  type SimulatorSnapshot,
} from './core';
import {
  SmartDialerDashboard,
  type DialerMode,
  type FailureId,
  type ScenarioId,
  type SimulationStatus,
} from './ui';
import {
  SCENARIO_TO_CORE,
  toDashboardViewModel,
} from './presentation';

const INITIAL_SCENARIO: ScenarioId = 'b';
const UI_FRAME_MS = 320;

function coreMode(mode: DialerMode): DialMode {
  return mode === 'progressive' ? 'PROGRESSIVE' : 'PREDICTIVE';
}

function createSimulator(scenarioId: ScenarioId, mode: DialMode): SmartDialerSimulator {
  const scenario = SCENARIO_TO_CORE[scenarioId];
  return new SmartDialerSimulator({
    scenario,
    mode,
    seed: `credresolve-ui:${scenario}:${mode}`,
  });
}

function isComplete(snapshot: SimulatorSnapshot): boolean {
  const activeCalls =
    snapshot.callCounts.RESERVED +
    snapshot.callCounts.INITIATED +
    snapshot.callCounts.RINGING +
    snapshot.callCounts.ANSWERED +
    snapshot.callCounts.CONNECTED;
  return snapshot.queueDepth === 0 && snapshot.nextProviderEvents === 0 && activeCalls === 0;
}

export default function App() {
  const simulatorRef = useRef<SmartDialerSimulator | null>(null);
  if (simulatorRef.current === null) {
    simulatorRef.current = createSimulator(INITIAL_SCENARIO, 'PREDICTIVE');
  }

  const [snapshot, setSnapshot] = useState<SimulatorSnapshot>(() => simulatorRef.current!.snapshot());
  const [status, setStatus] = useState<SimulationStatus>('idle');
  const [selectedScenarioId, setSelectedScenarioId] = useState<ScenarioId>(INITIAL_SCENARIO);
  const [activeFailures, setActiveFailures] = useState<Set<FailureId>>(() => new Set());
  const activeFailuresRef = useRef<Set<FailureId>>(new Set());
  const [runSequence, setRunSequence] = useState(0);
  const presetInjectedRef = useRef(false);
  const scenarioPhaseRef = useRef(0);

  const advance = useCallback(() => {
    const simulator = simulatorRef.current!;
    let next = simulator.step();
    if (!presetInjectedRef.current && selectedScenarioId === 'outage' && next.elapsedMs >= 4_000) {
      presetInjectedRef.current = true;
      next = simulator.inject({ type: 'PROVIDER_OUTAGE', durationMs: 15_000 });
    }
    if (!presetInjectedRef.current && selectedScenarioId === 'agent-drop' && next.elapsedMs >= 3_000) {
      presetInjectedRef.current = true;
      next = simulator.inject({ type: 'AGENT_DROP', count: 40 });
    }
    if (selectedScenarioId === 'd' && scenarioPhaseRef.current === 0 && next.elapsedMs >= 5_000) {
      scenarioPhaseRef.current = 1;
      next = simulator.configure({ answerRate: 0.7, averageTalkMs: 180_000 });
    }
    if (selectedScenarioId === 'd' && scenarioPhaseRef.current === 1 && next.elapsedMs >= 15_000) {
      scenarioPhaseRef.current = 2;
      next = simulator.configure({ answerRate: 0.2, averageTalkMs: 60_000 });
    }
    setSnapshot(next);
    if (isComplete(next)) setStatus('complete');
  }, [selectedScenarioId]);

  useEffect(() => {
    if (status !== 'running') return undefined;
    const timer = window.setInterval(advance, UI_FRAME_MS);
    return () => window.clearInterval(timer);
  }, [advance, status]);

  const handleModeChange = useCallback((mode: DialerMode) => {
    const next = simulatorRef.current!.configure({ mode: coreMode(mode) });
    setSnapshot(next);
  }, []);

  const resetScenario = useCallback((scenarioId: ScenarioId, mode: DialMode) => {
    const scenario = SCENARIO_TO_CORE[scenarioId];
    presetInjectedRef.current = false;
    scenarioPhaseRef.current = 0;
    activeFailuresRef.current = new Set();
    setActiveFailures(new Set());
    setStatus('idle');
    const next = simulatorRef.current!.reset({
      scenario,
      mode,
      seed: `credresolve-ui:${scenario}:${mode}`,
    });
    setSnapshot(next);
  }, []);

  const handleScenarioSelect = useCallback((scenarioId: ScenarioId) => {
    setSelectedScenarioId(scenarioId);
    resetScenario(scenarioId, snapshot.mode);
  }, [resetScenario, snapshot.mode]);

  const handleRun = useCallback(() => {
    if (isComplete(snapshot)) {
      resetScenario(selectedScenarioId, snapshot.mode);
    }
    setRunSequence((value) => value + 1);
    setStatus('running');
  }, [resetScenario, selectedScenarioId, snapshot]);

  const handlePause = useCallback(() => setStatus('paused'), []);
  const handleStep = useCallback(() => {
    setStatus('paused');
    advance();
  }, [advance]);

  const handleReset = useCallback(() => {
    resetScenario(selectedScenarioId, snapshot.mode);
  }, [resetScenario, selectedScenarioId, snapshot.mode]);

  const handleFailureToggle = useCallback((failureId: FailureId, active: boolean) => {
    const simulator = simulatorRef.current!;
    const nextFailures = new Set(activeFailuresRef.current);
    if (active) nextFailures.add(failureId);
    else nextFailures.delete(failureId);
    activeFailuresRef.current = nextFailures;
    setActiveFailures(nextFailures);

    let next = simulator.snapshot();
    switch (failureId) {
      case 'provider-latency':
        next = active
          ? simulator.inject({ type: 'PROVIDER_LATENCY', latencyMs: 3_500, durationMs: 3_600_000 })
          : simulator.inject({ type: 'CLEAR_RUNTIME_OVERRIDE', override: 'PROVIDER_LATENCY' });
        break;
      case 'provider-outage':
        next = active
          ? simulator.inject({ type: 'PROVIDER_OUTAGE', durationMs: 3_600_000 })
          : simulator.inject({ type: 'CLEAR_RUNTIME_OVERRIDE', override: 'PROVIDER_OUTAGE' });
        break;
      case 'agent-drop':
        if (active) {
          next = simulator.inject({ type: 'AGENT_DROP', count: Math.min(40, next.agentCounts.AVAILABLE) });
        } else {
          for (const agent of next.agents.filter((item) => item.state === 'OFFLINE').slice(0, 40)) {
            next = simulator.inject({ type: 'SET_AGENT_STATE', agentId: agent.id, state: 'AVAILABLE' });
          }
        }
        break;
      case 'answer-spike': {
        next = active
          ? simulator.inject({ type: 'ANSWER_SPIKE', answerRate: 0.9, durationMs: 3_600_000 })
          : simulator.inject({ type: 'CLEAR_RUNTIME_OVERRIDE', override: 'ANSWER_SPIKE' });
        break;
      }
      case 'webhook-loss':
        next = active
          ? simulator.inject({ type: 'WEBHOOK_LOSS', lossRate: 0.5, durationMs: 3_600_000 })
          : simulator.inject({ type: 'CLEAR_RUNTIME_OVERRIDE', override: 'WEBHOOK_LOSS' });
        break;
      case 'worker-crash':
        next = active
          ? simulator.inject({ type: 'WORKER_CRASH', recoverAfterMs: 12_000 })
          : simulator.inject({ type: 'WORKER_RECOVER' });
        break;
      case 'duplicate-events':
      case 'event-reordering': {
        const duplicates = nextFailures.has('duplicate-events');
        const reordered = nextFailures.has('event-reordering');
        const scenarioProvider = getScenario(SCENARIO_TO_CORE[selectedScenarioId]).config.provider ?? 'RELIABLE';
        next = simulator.configure({
          provider: duplicates || reordered ? 'CHAOS' : scenarioProvider,
          chaosProvider: {
            duplicateRate: duplicates ? 0.9 : 0.25,
            outOfOrderRate: reordered ? 0.9 : 0.2,
          },
        });
        break;
      }
    }
    setSnapshot(next);
  }, [selectedScenarioId]);

  const viewModel = useMemo(
    () => toDashboardViewModel(snapshot, {
      status,
      selectedScenarioId,
      activeFailures,
      runSequence,
    }),
    [activeFailures, runSequence, selectedScenarioId, snapshot, status],
  );

  return (
    <SmartDialerDashboard
      viewModel={viewModel}
      onModeChange={handleModeChange}
      onScenarioSelect={handleScenarioSelect}
      onRun={handleRun}
      onPause={handlePause}
      onStep={handleStep}
      onReset={handleReset}
      onFailureToggle={handleFailureToggle}
    />
  );
}
