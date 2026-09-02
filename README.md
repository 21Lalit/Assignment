# CredResolve SmartDialer

**SmartDialer safety and pacing control room for CredResolve's AI-native collections infrastructure.** It is a working, browser-based prototype for exploring utilization, call allocation, provider failure, and borrower-safe pacing decisions without placing real calls.

[Open the live project](https://21lalit.github.io/Assignment/) · [Read the assignment brief](./Tech%20Assignment%20-%20Hiring%202026.pdf) · [Architecture](./docs/architecture.md) · [Safety model](./docs/safety-model.md)

> No customer data or telecom traffic is used. This is an executable system-design prototype, not a production collections platform.

## What it demonstrates

The decision path is deliberately non-bypassable:

```text
Campaign conditions
  -> Progressive / Predictive pacing proposal
  -> Safety Controller
  -> atomic allocator
  -> provider abstraction
  -> idempotent event reducer
```

- **Progressive mode** starts no more agent-bound calls than it can atomically reserve against currently available agents.
- **Predictive mode** uses EWMA answer behavior, in-flight exposure, setup/talk time, uncertainty, recent campaign behavior, and provider health. It may start an approved prospecting call without an agent, then atomically assigns an available agent when the borrower answers.
- **Safety Controller** independently recomputes a capacity envelope, reduces or rejects proposals, and falls back to progressive probing for sparse history or degraded providers.
- **Explicit state machines** keep agent and call lifecycles valid. Duplicate and out-of-order provider events cannot rewind or reopen a call.
- **Failure simulation** covers worker crash/lease recovery, provider outage and circuit breaking, sudden agent loss, duplicate webhooks, and out-of-order webhooks.
- **Two provider adapters** share the same interface: a fast, ordered reliable mock and a slower chaos mock with timeouts, failures, duplication, and reordering.
- **Explainable operations UI** exposes pacing factors, requested versus approved volume, provider health, agent/call inventory, live invariants, and an audit timeline.

The visual language uses CredResolve orange and gold with a restrained operations-console layout. The product message keeps the purpose in view: utilization matters, but each answered attempt is a borrower conversation that deserves a safe handoff.

## Run locally

Requirements: [Node.js 20.11 or newer](https://nodejs.org/) and npm.

```bash
git clone https://github.com/21Lalit/Assignment.git
cd Assignment
npm ci
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). The simulator uses seeded virtual time, so it is fast and repeatable.

Production preview:

```bash
npm run build
npm run preview
```

## Control-room tour

1. Choose **Progressive** to inspect deterministic one-to-one reservation, or **Predictive** to see upper-confidence pacing and answer-time agent assignment.
2. Select a scenario, then use **Run**, **Pause**, **Step**, or **Reset**. Step is useful when explaining one safety decision in an interview.
3. Compare requested rate, approved rate, safe ceiling, binding factor, and model confidence in the Safety Controller panel.
4. Watch agent/call state, provider route health, throughput, and the decision/audit stream update from the same simulator snapshot.
5. Arm a resilience preset or failure toggle. Safety remains in the execution path while the shock is active.

### Campaign scenarios

| Scenario | Answer rate | Average talk time | What to inspect |
| --- | ---: | ---: | --- |
| A | 20% | 120 s | Predictive utilization opportunity with many no-answers |
| B | 50% | 90 s | Balanced baseline and steady-state pacing |
| C | 70% | 180 s | Capacity pressure from high answers and long conversations |
| D | Changes during run | Changes during run | Adaptation to non-stationary behavior plus provider noise |

Dedicated resilience scenarios also demonstrate worker crash, provider outage, a 40-of-100 agent drop, duplicate events, and out-of-order events. All randomness is seeded; replaying the same scenario starts from the same conditions.

## Tests and load test

```bash
# Domain, pacing, concurrency, provider, recovery, and scenario tests
npm test

# TypeScript compile plus the complete test suite
npm run check

# Deterministic 100 -> 1,000 -> 10,000 agent simulation
npm run load:test

# Production bundle (also catches type/build integration failures)
npm run build
```

The load script is a correctness-oriented synthetic test: it reports elapsed time, throughput/utilization, conflicts, and safety/invariant results. It does **not** claim telecom calls per second or a production SLA.

## Design notes

- [Architecture and scale](./docs/architecture.md) — components, transaction mapping, crash/outage/drop behavior, data model, observability, and the first bottleneck
- [Agent and call state machines](./docs/state-machines.md) — exact transitions and duplicate/out-of-order reduction
- [Predictive formula and safety invariants](./docs/safety-model.md) — proposal math, independent hard bound, fallbacks, and residual risk
- [ADR 001](./docs/adr/001-typescript-in-memory-core.md) — why TypeScript/in-memory is appropriate here and how it moves to PostgreSQL plus an at-least-once queue

## Repository map

```text
src/core/                 Domain types, allocator, pacing/safety, providers, scenarios, simulator
src/ui/                   CredResolve control-room components and view-model contract
scripts/load-test.ts      Synthetic scale run
docs/                     Architecture, state machines, safety model, ADR
.github/workflows/        Test/build-gated GitHub Pages deployment
Tech Assignment - Hiring 2026.pdf
```

## Deployment

The project is served at **https://21lalit.github.io/Assignment/**. A push to `main` triggers [the Pages workflow](./.github/workflows/deploy-pages.yml): Node 20, `npm ci`, tests, production build, artifact upload, then deployment. The deploy job cannot run if tests or compilation fail.

For a new fork, select **GitHub Actions** as the Pages source in repository settings, then run the workflow or push to `main`.

## Honest limitations

- State is browser memory. Refreshing resets the run; tabs and processes do not coordinate. The synchronous version checks demonstrate compare-and-set semantics, but production needs database transactions and constraints.
- Predictive safety is an upper-confidence risk envelope, not a proof that an extreme answer spike cannot exceed agents. The prototype records `unservedAnswers` and `safetyBreaches`; progressive mode is the deterministic no-oversubscription policy.
- Provider behavior is simulated. There is no Plivo/SIP integration, status reconciliation API, real queue, database, or durable outbox/inbox.
- The statistical model is transparent but deliberately small: no cohort calibration, correlation model, time-of-day policy, legal contact-window rules, consent/DNC system, or fairness evaluation.
- Authentication, tenant isolation, PII encryption/redaction, retention, RBAC, rate limiting, production alerting, and compliance review are outside this static prototype.
- Load-test results characterize deterministic in-process code and snapshot overhead, not networked multi-worker throughput.

## Final question

**How would I keep most predictive utilization while retaining progressive safety?**

I would make prediction advisory and give a separate Safety Controller sole authority over capacity. Progressive calls reserve an agent before dialing. Predictive calls can pre-dial only inside a conservative upper-confidence envelope that includes unresolved calls, live availability, agent-loss signals, provider health, and a campaign risk budget; an answer must atomically claim an agent capacity token before it can connect. Sparse data, degraded providers, any breach, or stale capacity immediately forces progressive mode. Transactions, unique constraints, outbox/inbox idempotency, leases, and reconciliation preserve that rule across crashes and retries.

There is an unavoidable boundary: if “deterministic safety” means zero possibility of an unserved answer under every outcome, the system cannot start more agent-bound calls than guaranteed agents. In that policy, prediction should optimize **which** borrower and **when** to call while the hard start count remains progressive. If the business accepts a quantified tail risk, predictive pre-dialing can reclaim more utilization—but that risk must be explicit, measured, and impossible for the pacing model to bypass.
