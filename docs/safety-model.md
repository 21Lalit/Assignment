# Predictive pacing and safety model

## Boundary first

The predictive engine in [`src/core/pacing.ts`](../src/core/pacing.ts) returns a number and an explanation. It has no allocator or provider reference. The only executable path is:

```text
Pacing proposal -> SafetyController.evaluate
  -> progressive/fallback: reserve agent + borrower -> provider.dial
  -> predictive: reserve borrower -> provider.dial -> on ANSWERED, atomically assign agent
```

That separation is deliberate. Statistical estimates may be wrong; ownership and state-machine invariants must remain true even when the forecast misses, and misses must be visible as safety breaches.

## Predictive proposal

For one decision tick, define:

| Symbol | Input |
| --- | --- |
| `A` | agents currently `AVAILABLE` |
| `C` | agents currently `CONNECTED` |
| `p` | EWMA answer rate, clamped to `[minAnswerRate, 0.99]` |
| `p_recent` | observed recent answer rate |
| `S`, `T` | average setup and talk time in milliseconds |
| `I`, `R`, `H` | calls initiated, ringing, and answered |
| `z` | configured uncertainty coefficient |
| `health` | provider health score in `[0, 1]` |

The model computes:

```text
behavior       = clamp(p_recent / p, 0.65, 1.15)
provider       = clamp(health, 0.20, 1.00)
release        = C * clamp(S / T, 0, 0.50)
n               = R + 0.65 * I
expected        = H + n * p
uncertainty     = z * sqrt(n * p * (1 - p))
answerCapacity  = A + release
unserved        = max(0, answerCapacity - expected - uncertainty)
rawAttempts     = unserved / p
proposal        = floor(rawAttempts * behavior * provider)
```

The final proposal is also bounded by ready borrowers, provider headroom, and the configured batch limit.

Why these terms exist:

- Dividing free answer capacity by `p` produces the predictive utilization opportunity.
- `expected` accounts for work already in flight; initiated calls receive a conservative `0.65` exposure weight and ringing calls a full exposure weight.
- The binomial-style uncertainty term grows when there are more unresolved calls or answer-rate uncertainty is high.
- `release` is a forecast that some connected agents will finish while new calls set up. It is capped at half the connected pool.
- Recent borrower behavior and provider health can only move pacing within narrow clamps, preventing a single noisy window from multiplying volume without bound.

This is an explainable heuristic, not an ML claim. Each proposal exposes its formula, factors, and prose explanation in the simulator snapshot.

## Non-bypassable hard controller

First the controller computes an absolute per-tick input bound:

```text
absoluteNewLimit = min(READY borrowers, provider headroom, maximum batch size)
```

Progressive mode additionally limits that value to `AVAILABLE` agents. Predictive mode searches for the largest additional attempt count `x <= absoluteNewLimit` whose conservative answer exposure fits live capacity:

```text
current = unassigned calls already in flight
upper(current + x) = (current + x) * p
                   + z * sqrt((current + x) * p * (1 - p))

predictiveHardCapacity = largest x where upper(current + x) <= AVAILABLE agents
```

The implementation uses a binary search, so safety is independently recomputed rather than trusting the pacing engine's requested count.

Decision order:

| Condition | Action |
| --- | --- |
| Provider circuit is `OPEN` | `REJECT`, approve `0` |
| `hardCapacity` is `0` | `REJECT`, approve `0` |
| Proposal is `0` | `REJECT`, approve `0` |
| Predictive history is below the configured minimum | `FALLBACK_PROGRESSIVE`, approve at most the probe batch |
| Provider health is degraded or circuit is `HALF_OPEN` | `FALLBACK_PROGRESSIVE`, approve at most the probe batch |
| Proposal exceeds `hardCapacity` | `REDUCE` to `hardCapacity` |
| Otherwise | `APPROVE` the proposal |

Crucially, `release` can make a predictive **proposal** larger, but forecast releases do not become controller capacity. Progressive starts are always one-to-one. Predictive starts may exceed current agents only where the upper-confidence answer bound still fits them; each eventual answer must win an atomic agent assignment before `CONNECTED`.

## Safety invariants

The simulator checks and reports these continuously:

1. `0 <= approvedCalls <= hardCapacity` for every decision.
2. In progressive/fallback mode, `hardCapacity <= AVAILABLE agents` and each started call is agent-backed.
3. In predictive mode, `upper(unassignedInFlight + hardCapacity) <= AVAILABLE agents` at authorization time.
4. Every active call owns exactly one borrower; an unassigned predictive setup call may temporarily own no agent.
5. No agent or borrower appears in more than one active assignment/reservation.
6. A predictive call cannot become `CONNECTED` until atomic agent assignment succeeds.
7. A provider request is made only for a successfully committed borrower/call reservation.
8. An open provider circuit starts no new calls; call state is monotonic and terminal states are absorbing.

There are two layers to the concurrency argument:

- The controller limits intended work to a mode-specific capacity envelope.
- The allocator rechecks state and version at the commit point. If an agent changed between reading and answer-time assignment, the losing operation returns a conflict instead of double-assigning it.

Thus `approvedCalls` is an upper bound, not a promise that every reservation will succeed.

## What happens when estimates are wrong?

- **Answer rate jumps:** the upper-confidence envelope reduces new exposure, but an extreme tail can still produce more simultaneous answers than agents. Those answers are counted as `unservedAnswers`/`safetyBreaches`; ownership remains consistent.
- **Answer rate collapses:** the EWMA and recent-behavior multiplier reduce subsequent proposals; no safety property depends on that adaptation being fast.
- **Forty agents disappear:** the next context rebuild sees the smaller `AVAILABLE` count. Answer-time assignment performs another state/version check, so stale proposals cannot claim disappeared agents; previously approved predictive exposure can still create an unserved answer, which is surfaced as a breach.
- **Provider degrades:** its health multiplier reduces the proposal. A degraded or half-open circuit forces progressive probes; an open circuit rejects all new work.

## Calibration and production policy

Before real use, tune `minAnswerRate`, `z`, EWMA alpha, sample threshold, setup exposure weight, and provider thresholds from campaign cohorts and validate them with replay/backtesting. Alert on abandon probability, not only utilization.

A production system can reclaim more predictive benefit by issuing limited pre-dials against **durable future-capacity tokens** (for example, agents with a near-certain wrap-up deadline), while maintaining a separately calculated worst-case bridge reserve and an immediate stop rule. That policy must explicitly define its allowed abandonment risk; zero abandonment under all answer outcomes is mathematically incompatible with starting more agent-bound calls than currently guaranteed agents. This prototype makes an explicit upper-confidence trade-off and reports the tail outcome; progressive mode remains the strict zero-oversubscription option.
