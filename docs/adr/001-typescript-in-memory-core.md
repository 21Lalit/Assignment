# ADR 001: TypeScript in-memory core, with a transactional production seam

- **Status:** Accepted for the assignment prototype
- **Date:** 2026-09-01
- **Decision owners:** SmartDialer team

## Context

The assignment is primarily about pacing safety, allocation races, disorderly provider events, and recovery. A distributed deployment would add operational surface without making those decisions easier to inspect. The deliverable also needs to run as a static GitHub Pages project, so it cannot depend on a server or database at demonstration time.

The prototype still needs boundaries that can survive a production migration. In particular, pacing must not call a provider, provider behavior must sit behind an interface, state transitions must be deterministic, and reservation semantics must have a clear database equivalent.

## Decision

Build the executable model in TypeScript and keep prototype state in memory.

- TypeScript shares domain types between the simulator and React control room and makes impossible or missing state cases visible during compilation.
- A seeded, virtual-time simulator makes failure cases quick and repeatable; tests do not wait for wall-clock telecom timings.
- The in-memory store owns allocation critical sections and version checks. Progressive mode atomically reserves agent + borrower + call; predictive mode reserves borrower + call, then atomically claims an available agent when the borrower answers.
- The pacing engine emits a proposal only. The safety controller is a separate, mandatory boundary before allocation/provider initiation.
- Provider adapters implement one interface; reliable and chaotic mocks exercise the same dialer path.
- Provider events are reduced into monotonic call state using event IDs, rather than applied as arbitrary assignments.

For production, retain the domain and provider interfaces but replace the in-memory durability and scheduling seams with **PostgreSQL plus an at-least-once queue**.

1. In progressive mode, reserve an eligible agent and borrower in one short PostgreSQL transaction using conditional versions and/or `SELECT ... FOR UPDATE SKIP LOCKED`. In predictive mode, reserve only the borrower/call at initiation and perform the same transactional agent claim while reducing the answer event.
2. Enforce one active reservation with database constraints, not process-local locks.
3. Insert a provider-command outbox row in that same transaction. A queue relay publishes it after commit.
4. Send a stable call ID as the provider idempotency key. Never hold a database transaction open during a network request.
5. Ingest webhooks into an inbox table with a unique provider-event key; store the inbox row and state change atomically.
6. Use expiring ownership leases and a reconciler for abandoned jobs and ambiguous provider outcomes.

The queue is a delivery mechanism, not the source of truth. PostgreSQL owns allocation and call state; consumers are expected to retry and therefore make every effect idempotent.

## Consequences

### Positive

- The important algorithms are runnable in a browser and understandable in one sitting.
- Seeded tests can reproduce race, outage, duplicate, out-of-order, and recovery cases.
- There is no false claim of exactly-once delivery. Correctness comes from atomic state changes, stable keys, monotonic reducers, and reconciliation.
- The static demo has no infrastructure cost and can be deployed by GitHub Actions.

### Negative

- Process memory is neither durable nor shared; a refresh resets the demo and multiple browser tabs are independent systems.
- The prototype's atomic section proves local semantics, not cross-process behavior under a real isolation level.
- Mock-provider latency and throughput results characterize this model, not a telecom network or production SLA.
- A browser dashboard cannot provide authentication, authorization, PII controls, retention, or compliance evidence.

## Alternatives considered

- **PostgreSQL in the initial submission:** closer to production, but it prevents a zero-service Pages demo and spends the timebox on environment setup rather than safety behavior.
- **Redis locks as the primary allocator:** fast, but lock expiry and database ownership can diverge. A database conditional update/constraint is a smaller correctness surface.
- **Kafka/event sourcing from day one:** useful at very high event volume, but unnecessary for this prototype and does not remove the need for transactional allocation or idempotent projections.
- **A probabilistic/ML pacing service:** premature. A transparent statistical rule with an independent hard controller is easier to verify and defend.

## Migration trigger

Move off the in-memory store before any real borrower/agent traffic, multi-process worker deployment, or durability requirement. Introduce PostgreSQL first, then the transactional outbox/inbox and queue. Partitioning and streaming infrastructure follow measured contention or webhook volume; they are not prerequisites for correctness.
