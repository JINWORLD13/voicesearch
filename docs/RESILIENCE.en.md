[한국어](RESILIENCE.md) | [日本語](RESILIENCE.ja.md) | **English**

# Resilience Design

This project's server is a gateway wrapping an external AI API that is slow
(5–7s responses), intermittently failing (429/503), and rate-limited. So the
core problem is not "how much can it process" but "how does my server stay
standing when the outside wobbles."

I decided in code what to give up and what to protect when load spikes or the
external API dies, and quantified those decisions with load tests. Below, each
decision follows Problem (P) → Alternatives (A) → Action (implementation) →
Results (R).

---

## Target structure: four layers of defense

```
search request
 → [1] Rate Limiter (per-IP Token Bucket) ──over──▶ 429 (safe rejection)
 → [2] Circuit Breaker (fail fast when the external AI dies) ──open──▶ fallback
 → [3] Bulkhead (per-API concurrency isolation) ──saturated──▶ queue/reject
 → [4] Graceful Degradation (drop TTS first, then streaming, under overload)
 → normal processing (+ answer cache serves repeated questions instantly)
```

The earlier the layer, the cheaper the block. The rate limiter cuts requests
with a 429 before any external call happens; layers further in spend real
resources.

---

## [1] Rate Limiter — one user's flood must not sink everyone

Problem
One user (or one buggy client) firing dozens of requests per second eats the
external AI's request quota, and every other well-behaved user starts seeing
429s. One person's mistake becomes everyone's outage. This has to be stopped at
the front door.

Alternatives

| Approach | Behavior | Verdict |
|---|---|---|
| Fixed Window | N per minute; easy to build | 2× bursts at window edges (N at :59 + N at :01) |
| Sliding Window | fixes the edge problem | records every request timestamp — memory/CPU heavy |
| Leaky Bucket | drains at a constant rate | punishes even healthy short bursts (fits payment APIs) |
| Token Bucket | allows bursts, caps the average | chosen |

Search traffic is "quiet most of the time, occasionally bursty," so Token
Bucket — bursts allowed up to capacity, sustained rate capped by refill — fit
best.

Implementation and rationale
Hand-rolled ([server/src/resilience/rateLimiter.ts](../server/src/resilience/rateLimiter.ts)).
Tokens are not refilled by timers; on each request the bucket refills by
"elapsed time since last refill × refill rate" (lazy computation), avoiding one
timer per IP. The key prefers X-Forwarded-For (the real IP behind a proxy).
Voice (/api/voice) shares the same per-IP bucket as search — otherwise repeated
voice calls alone could drain the monthly ElevenLabs quota (the semaphore caps
concurrency, not volume).

Known limitation: X-Forwarded-For is a client-controllable header, so hitting
the server directly with fake IPs can bypass the per-IP limit (this is exactly
how the load tool simulates many virtual users). In production you would set
Express's `trust proxy` to the number of trusted hops and use `req.ip`. As a
single demo server, I chose the simpler path.

Results (measured)
With capacity 5 and refill 2/s, 12 rapid-fire requests from one IP → the first 7
pass (burst + refill in between), the rest get 429. Other IPs at the same moment
all pass. Per-user isolation works.
Five unit tests pin down burst exhaustion, refill over time, the capacity cap,
key independence, and immediate application of runtime config changes.

Alternatives & scaling
In practice, `rate-limiter-flexible` (swappable memory/Redis/Postgres backends)
is more common than rolling your own. At scale the limit moves out of app code
entirely — nginx `limit_req`, or an API gateway like Kong/Envoy, before the app.
Hand-rolling here was deliberate: showing in code that I understand the Token
Bucket mechanics.

---

## [2] Circuit Breaker — stop knocking on a dead door

Problem
When the external AI is down, every call hangs until timeout and then fails.
Users wait 5 seconds for an error, and server resources are wasted holding those
doomed calls. Most large outages are "kept calling a dead dependency until the
whole thing cascaded."

Alternatives

| Approach | Notes | Verdict |
|---|---|---|
| Retry only | fine for transient blips | against a truly dead API, retries add load |
| opossum | the standard Node CB library | proven; CB only |
| cockatiel | newer; CB+retry+timeout+bulkhead unified | could replace my four layers with one lib |
| Resilience4j | the Java/Spring standard | different stack |
| Hystrix | the Netflix original | deprecated; not for new projects |
| Istio/Envoy outlier detection | service-mesh level | infra handles it without app code |

Implementation and rationale
Hand-rolled ([circuitBreaker.ts](../server/src/resilience/circuitBreaker.ts)):
three states, closed→open→half-open. When consecutive failures cross the
threshold (default 5) the circuit opens and fails instantly; after resetMs
(default 10s) a single trial call (half-open) probes recovery. Threshold 5 was
picked so retries absorb momentary blips and only failures beyond that open the
circuit. Hand-rolling exists to prove the state transitions with unit tests.

Results (measured, with a 50% failure rate injected)

| | Circuit ON | Circuit OFF |
|---|---|---|
| Wall clock | 8.9s | 16.5s |
| p50 latency | 649ms | 3924ms |
| Fast failures (circuit_open) | 97 | 0 |

The dead API was short-circuited 97 times, halving wall-clock time and cutting
p50 six-fold. Success rate is actually lower with the circuit ON (30% vs 46%) —
an intentional trade-off. The circuit chooses "we're down now, fail fast,
recover later": failing in 0.6s and retrying beats hanging for 8 seconds before
failing.

State of the art
opossum is the standard, but cockatiel is newer and composes circuit breaker +
retry + timeout + bulkhead as policies in one library (the Node take on .NET's
Polly). In production, replacing my four hand-rolled layers with cockatiel would
be the maintainable choice.

---

## [3] Bulkhead — one API eating resources must not kill the others

Problem
Like a ship's watertight compartments: even if one external API slows down and
requests pile up, the other features must not drown with it. Gemini being stuck
must not stop voice (ElevenLabs) or search (Exa).

Approach
Took the OS concept of a semaphore to the application level. Each external
dependency gets its own semaphore capping concurrent calls
([guards.ts](../server/src/guards.ts)) — gemini, exa, and elevenlabs each own
their slots, so one saturating doesn't touch the others. That is the Bulkhead
pattern.

- Instead of a fixed cap (e.g. 8), the modern approach is Netflix
  concurrency-limits' adaptive style (adjusting the cap live from observed
  latency, AIMD like TCP congestion control). No need to guess the right number
  up front — but for this scope a fixed cap is easier to understand and enough.
- `p-limit`/`p-queue` could provide the concurrency cap instead of hand-rolling.
- With a database this would extend to separate read/write connection pools, or
  an external pooler like PgBouncer. No DB here, so not applicable.

Results
Under concurrent load, outbound calls never exceed the semaphore cap, so the
external API's rate limit is never tripped. The dashboard shows gemini.inUse
(running) and queued (waiting) live.

---

## [4] Graceful Degradation — decide what to give up first

Problem
Under severe overload, "save everything" is impossible. The real decision is
priority: what gets dropped first, and what must survive.

Action
Priorities for voicesearch, implemented as four levels
([runtimeConfig.ts](../server/src/runtimeConfig.ts)):

| Level | Gives up | Protects |
|---|---|---|
| none | (nothing) | everything |
| no-tts | speech synthesis (heaviest, least essential) | search + streaming |
| cache-only | new external calls | cached answers |
| reject | new searches entirely | server/external resources |

Why speech synthesis goes first: it is the heaviest (external call + audio
transfer), and its failure degrades gracefully — the frontend falls back to the
browser voice, so the experience never fully breaks.

Results
Injecting level "reject" from the dashboard makes new searches fail instantly
and voice return 503 (triggering the fallback). It is manual today
(dashboard-injected); a natural extension is escalating levels automatically
from semaphore queue length or circuit state.

Interview prep: "What did you switch off first under overload?" → "Speech
synthesis. It's the heaviest, and turning it off still leaves the core (the
searched answer) intact thanks to the browser-voice fallback."

---

## Also: cache · retry · timeout

Answer cache (LRU + TTL, [cache.ts](../server/src/resilience/cache.ts))
A repeated question skips the LLM call (5–7s + cost) entirely. Measured:

| | Cache ON | Cache OFF |
|---|---|---|
| p50 latency | 1ms | 3905ms |
| Throughput | 32.4 req/s | 12.1 req/s |

Under load with repeated questions mixed in: p50 3905ms→1ms, 2.7× throughput.
LRU rides on Map's insertion-order property; TTL on stored timestamps.
Alternatives: `lru-cache` (more sophisticated), or Redis once there are multiple
instances (see "scaling" below). A single instance keeps in-memory sufficient.

Retry (exponential backoff)
Only transient errors (429/5xx) are retried at 0.5s→1s→2s. Errors like 401 (bad
key) are thrown immediately — retrying cannot fix them. Retries wrap only the
call that opens the stream: once tokens are flowing, a retry would append a
duplicate answer on top of what's already on screen.

Timeout
Every external call gets a ceiling. A call hanging without a response would
otherwise pin a connection and memory; pile those up under load and the server
stalls. These four (circuit/retry/semaphore/timeout) wrap every call as one
layer in [guard.ts](../server/src/resilience/guard.ts).

---

## Load-testing methodology

Key decision: you can't load-test the real Gemini (rate limits + cost, and it
proves nothing about my code). So the external LLM is replaced with a mock that
is "slow and occasionally failing"
([mockLlm.ts](../server/src/mockLlm.ts)). The only variable left is my server
layer, so resilience is measured in isolation. Failure rate and latency are
adjustable at runtime to reproduce calm/failure/overload scenarios.

Tools
- Custom script ([loadtest/run.mts](../loadtest/run.mts)): reads SSE to `done`,
  aggregating scenario-level outcomes (cache hits, fallbacks) and client-side
  p50/p95/p99. Standard tools struggle to measure "time to completion" for SSE
  streams, hence custom.
- k6 ([loadtest/k6-throughput.js](../loadtest/k6-throughput.js),
  [k6-ratelimit.js](../loadtest/k6-ratelimit.js)): a standard tool for ramping
  load, automatic threshold verdicts, and 429 block-rate measurement.
- The server's own metrics (/api/metrics): circuit state, semaphore occupancy,
  cache hit rate — aggregated server-side to cross-check client measurements.

---

## Observability — you can only decide if you can see the defenses fire

Defense logic is only useful if you can see when it fired — that's what lets you
pinpoint a cause within seconds during a real incident.

- Structured logging (pino): one JSON line per event, machine-aggregatable later.
- In-memory metrics ([metrics.ts](../server/src/metrics.ts)): latency
  percentiles (p50/p95/p99), per-outcome counters, cache hit rate. Percentiles
  instead of averages because averages hide the slowest 5% — the part users
  actually feel (SLOs are set on p95).
- Live dashboard ([web/src/Dashboard.tsx](../web/src/Dashboard.tsx)): polls
  metrics every second, draws charts, and hosts the failure/load-injection
  buttons. Press "kill the external AI" and you watch the circuit turn red
  (open) and the request graph spike, live.

The metrics are in-memory and vanish on restart. In production this becomes
Prometheus + Grafana (the dashboard here is a miniature of that).

---

## The server's own survival — failures beyond the external dependency

Everything above defends against the external AI wobbling. But real services
also fail at the process and deployment level. Handled too:

| Variable | Handling |
|---|---|
| Client disconnect (tab closed, etc.) | detected via res 'close' → stop consuming the stream, never write to a dead socket, never cache the truncated partial answer, and count it as aborted (requests.aborted), not success |
| Process crash | uncaughtException/unhandledRejection logged (last-resort safety net) |
| Deploy restart (SIGTERM) | graceful shutdown: stop accepting, finish in-flight requests, force-exit after 10s |
| Health check | /api/health for load balancers / deploy platforms to probe liveness |
| Oversized payloads | 16kb body limit (questions are ~200 chars) |
| CORS | production allows only FRONTEND_URL; open in local dev |
| Failure-injection endpoints exposed | /api/admin/config and /api/metrics/reset are public by default (the demo intends visitors to try injection). Abandoned injections auto-revert 10 minutes after the last change, and setting ADMIN_TOKEN locks them behind an x-admin-token header (CORS only stops browsers, not curl — locking requires auth) |

The disconnect handling matters most. If a user closes the tab mid-search, an
unaware server keeps calling the external AI and then errors writing to a dead
socket. Under load, those zombie tasks pile up and waste resources. The res
'close' event catches this and stops the generation.

Limitation: a timeout rejects the promise but does not cancel the in-flight
external call itself (no AbortController wired into the SDKs). The call briefly
keeps consuming resources after the timeout. Next on the list.

## Can it take a crowd? — the honest answer

A single instance doesn't die under a rush. The rate limiter rejects the excess
safely with 429s, the semaphores cap outbound calls, and the cache absorbs
repeats. It doesn't "blow up" — it "politely declines the overflow."

But throughput itself is bounded by the external LLM's speed (5–7s), so it's
low. In a real rush, many users get 429s: safe, but effectively a service in
refusal mode.

True scale means multiple instances, and there's a trap: the rate limiter,
cache, and metrics are all in-memory, so instances can't share state. Spread
users across 3 instances and the rate limit effectively loosens 3×, cache hit
rates drop, and metrics fragment. Horizontal scaling therefore means moving
this state to Redis (rate-limit counters, shared cache, metric aggregation).
That's the next stage.

## What this architecture deliberately leaves out (honest scope)

Decision points that come up in chat-system robustness discussions but don't
apply here were not forced in. voicesearch is stateless request-response search,
not a chat system that stores and delivers messages.

- Message-loss prevention (write to DB first, then notify): no messages to
  store. No DB at all.
- Retry safety (idempotency): chat's "no duplicate inserts" doesn't apply. The
  answer cache partially covers "don't process the same request twice."
- Pub/Sub real-time delivery: single-shot search, no broadcast.
- Autoscaling: an infrastructure-level decision outside app code. Scale up
  ahead of predictable spikes.

This section exists to distinguish "left out knowingly" from "didn't know."
For a chat system, each of these would be DB-first writes, unique-message-ID
dedup, and a message queue (BullMQ or similar).

---

## Meta point: app code vs infrastructure

One axis repeats across all the alternatives above — "write it in application
code, or delegate to infrastructure (API gateway / service mesh)." This project
chose app code everywhere because the goal is a portfolio that proves
understanding in code. A large production service would move much of the rate
limiting and circuit breaking to the Envoy/API-gateway level.

If an interviewer asks "why code instead of infrastructure?": "At this scope the
goal was proving understanding; when scaling to production, moving these to the
infrastructure level is the right call."

---

## Alternatives summary

| Layer | This project | Library | Infrastructure level |
|---|---|---|---|
| Rate limit | hand-rolled Token Bucket | rate-limiter-flexible | nginx limit_req, Kong/Envoy |
| Concurrency | hand-rolled Semaphore | p-limit, Netflix concurrency-limits | — |
| Circuit breaker | own 3-state | opossum, cockatiel (newer) | Istio/Envoy outlier detection |
| Bulkhead | per-API semaphores | cockatiel | service separation |
| Cache | hand-rolled LRU+TTL | lru-cache | Redis |
| Observability | in-memory + dashboard | — | Prometheus + Grafana |

---

## Limitations and next

- The timeout covers only opening the stream. An idle timeout for tokens
  trickling too slowly mid-stream is a next step.
- Graceful degradation is manual (injected). It could escalate automatically
  from semaphore queue length or circuit state.
- Metrics are in-memory, single-instance by assumption. Multiple instances mean
  moving to Prometheus.
- The concurrency cap is fixed. Netflix-style adaptive limits (AIMD) would
  remove the need to pick the number up front.
