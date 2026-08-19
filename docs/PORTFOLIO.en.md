[한국어](PORTFOLIO.md) | [日本語](PORTFOLIO.ja.md) | **English**

# VoiceSearch

A search service you talk to: it searches the web, answers with sources, and
reads the answer back out loud. Built as a new-grad developer portfolio.

One-line summary: voice input → web search → the LLM streams a grounded answer →
voice output. Designed to keep working through fallback paths even when external
API keys are missing.

---

## Demo

Live link: https://voicesearch-cwh9.onrender.com (free Render tier — the first request may be slow)

![Search view — sources appear first, the answer streams in, then it is read aloud](screenshots/search.png)

![Dashboard after failure injection — the circuit opens, 429s and aborts are counted, and the event log records the circuit opening](screenshots/dashboard.png)

How to run it locally is in the [README](../README.en.md#running-it).

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (React + TypeScript, :5173)          │
│                                               │
│  Mic ── Web Speech API ──▶ text               │
│                                 │             │
│  View ◀── SSE event parsing ◀───┤             │
│  (source cards / streamed answer)│            │
│                                 ▼             │
└─────────────────────────────┬─────────────────┘
                              │ POST /api/search
                              │ POST /api/voice
                              ▼
┌─────────────────────────────────────────────┐
│  Server (Express + TypeScript, :3001)         │
│                                               │
│  routes/search.ts  ── path selection          │
│       │               (the conductor)         │
│       ├─ EXA_API_KEY set ─▶ exa.ts            │
│       │                     (web search, 5)   │
│       │                         │             │
│       │                         ▼             │
│       │                     llm.ts            │
│       │              (Gemini/OpenAI gen)      │
│       │                                       │
│       └─ not set ─▶ llm.ts (Gemini built-in   │
│                             Google Search)    │
│                                               │
│  routes/voice.ts ── ElevenLabs TTS proxy      │
└─────────────────────────────┬─────────────────┘
                              │
                  ┌───────────┼───────────┐
                  ▼           ▼           ▼
              Gemini API   Exa API   ElevenLabs API
            (search+gen)  (web search) (speech)
```

Data flow in one line:
question text → (search) → results → (LLM) → answer chunks → SSE → screen → (optional) mp3

---

## Why these technologies

### Why two search paths (Exa / Gemini built-in search)

At first there was only the Exa search API. But Exa requires signing up and
issuing an API key, so someone opening the app for the first time saw nothing
but a "no search results" error because of one missing key.

Gemini has built-in Google Search (grounding). So when the Exa key is missing,
the app automatically switches to a path where Gemini searches on its own. The
result: the whole thing runs on a single GEMINI_API_KEY.

The trade-off between the two:

| | Exa path | Gemini built-in search |
|---|---|---|
| Required keys | Exa + Gemini | Gemini only |
| Control over results | count and excerpts directly controlled | none |
| Source links | original URLs | Google redirect URLs |
| Inline [1] markers | yes | no |

Exa when fine-grained control matters, built-in search when convenience wins —
pick per situation.

### Why support both Gemini and OpenAI

To avoid being tied to one company's API, the provider switches with a single
.env value (LLM_PROVIDER). The two SDKs stream in different shapes, so both are
wrapped as "an async generator that yields text chunks" — route code doesn't
need to know which one is attached.

### Why SSE (not WebSocket)

Generating an answer takes 4–7 seconds. Deliver it all at once and the user
stares at an empty screen the whole time; stream the chunks as they are produced
and the text fills in.

The direction is server→client only, so SSE is enough. SSE is plain HTTP and
simpler than WebSocket. If bidirectional signaling (e.g. a cancel-generation
signal) becomes necessary, WebSocket can be considered then.

### Why the voice has a fallback

The ElevenLabs free plan caps at 10k characters a month, so the limit can be hit
at any time. When speech synthesis fails, the browser's built-in voice
(speechSynthesis) reads the answer instead. The design goal was that a quota
never silences the demo.

---

## Problems I hit and how I solved them

### 1. The external search API was an entry barrier

Problem: with Exa as the only search engine, a first-time user had to sign up
for Exa and issue a key before seeing anything work. From a portfolio reviewer's
point of view, one missing key meant nothing but a "no search results" error.

Root cause: search and generation were tightly coupled to Exa. Only the search
part needed to be swappable, but the structure didn't allow it.

Fix: the search route branches on key presence. With an Exa key it works as
before; without one, Gemini's built-in Google Search does search and generation
in a single call. The whole app now runs on the Gemini key I already had, and
the frontend needed almost no changes because it renders purely by event type
(one added line for the phase transition on delta).

Lesson: design the "path when it's absent" together with every external
dependency. The same principle drives the voice fallback (ElevenLabs failure →
browser voice), applied consistently across the app.

### 2. Streaming responses broke the parser mid-chunk

Problem: the frontend occasionally blew up on JSON.parse of events the server
streamed over SSE. It reproduced rarely, which made it nasty to track down.

Root cause: the network does not deliver data in the event units I sent. A chunk
can end at `data: {"type":"del` with the rest — `ta","text":"..."}` — arriving
in the next chunk; boundaries are arbitrary. Parsing each chunk as it arrived
meant parsing half a JSON object.

Fix: accumulate into a buffer and split only on the event delimiter (a blank
line). The final piece of each split may still be incomplete, so it is not
parsed — it stays in the buffer for the next turn.

```ts
// web/src/api.ts — the essential part
buffer += decoder.decode(value, { stream: true });
const parts = buffer.split("\n\n");  // events are separated by blank lines
buffer = parts.pop() ?? "";          // keep the last, possibly incomplete piece
for (const part of parts) {
  const line = part.trim();
  if (!line.startsWith("data:")) continue;
  let event: SearchEvent;
  try {
    event = JSON.parse(line.slice(5));
  } catch {
    continue;                          // one broken piece must not kill the stream
  }
  onEvent(event);
}
```

Lesson: streams arrive in bytes, not messages. You manage the boundaries
yourself — I now know that in my hands, not just in theory.

---

## Four layers of defense against overload and failure

The server wraps an external AI that is slow (5–7s) and occasionally failing,
so the core problem is "keep standing when the outside wobbles," not "process
more."

```
request → [1] Rate Limiter (per-IP Token Bucket, hand-rolled) ─over─▶ safe 429
        → [2] Circuit Breaker (open after consecutive failures, fail fast)
        → [3] Bulkhead (per-external-API semaphores isolate concurrency)
        → [4] Graceful Degradation (under overload, drop TTS first, in order)
        → normal processing (+ LRU+TTL cache answers repeats instantly)
```

Representative measured numbers from load tests:

- Answer cache: with repeated questions in the mix, p50 3905ms → 1ms, 2.7× throughput
- Circuit breaker: with a 50% failure rate injected, wall-clock halved (16.5s → 8.9s), p50 6× shorter
- Rate limiter: one IP flooding gets 429s while every other IP passes at the same moment

Inject failures from the dashboard ("kill the external AI" and friends) and you
can watch the circuit open and the graphs spike in real time. The alternatives
comparison for each layer (libraries / infrastructure level) and the measurement
methodology are in [RESILIENCE.en.md](RESILIENCE.en.md). The failure-injection
endpoints are public by default so visitors can try them; abandoned injections
auto-revert 10 minutes after the last change, and setting ADMIN_TOKEN locks them.

---

## Metrics

Response time (measured, Gemini built-in search path, 5 questions):

| Question | Time |
|---|---|
| What's the minimum wage in 2026? | 5.0s |
| Recommend recently released movies | 5.9s |
| How did EV subsidies change this year? | 7.0s |
| Seoul weather today | 4.6s |
| What's the exchange rate now? | 4.3s |

Average about 5.3s (search + LLM generation included; first token arrives sooner).

Other metrics (slots to fill post-deployment):
- Users:
- Daily searches:
- Time to first byte (TTFB):

---

## Core logic snippets

Not the whole codebase — just the parts where the design intent shows.

### Search path selection (the conductor)

server/src/routes/search.ts — branching on key presence.

```ts
if (!process.env.EXA_API_KEY) {
  // No Exa key: Gemini built-in Google Search does search + generation at once
  for await (const event of streamGroundedAnswer(question)) {
    if (event.kind === "text") send({ type: "delta", text: event.text });
    else send({ type: "sources", sources: /* referenced pages */ });
  }
  return res.end();
}

// With an Exa key: search first, send sources before the answer
const results = await searchWeb(question);
send({ type: "sources", sources: /* 5 results */ });
for await (const text of streamAnswer(question, results)) {
  send({ type: "delta", text });
}
send({ type: "done", elapsedMs: Date.now() - started });
```

### Two LLM SDKs unified into one (adapter)

server/src/llm.ts — two differently-shaped APIs behind the same shell.

```ts
async function* streamGemini(prompt: string) {
  const stream = await ai.models.generateContentStream({ model, contents: prompt });
  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;            // Gemini: chunk.text
  }
}

async function* streamOpenAI(prompt: string) {
  const stream = await openai.chat.completions.create({ model, messages, stream: true });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content; // OpenAI: here
    if (text) yield text;
  }
}

// Routes don't need to know which provider is attached
export function streamAnswer(question, sources) {
  const prompt = buildPrompt(question, sources);
  return process.env.LLM_PROVIDER === "openai" ? streamOpenAI(prompt) : streamGemini(prompt);
}
```

### The protection wrapper: four layers in one wrapped call

server/src/resilience/guard.ts — every external API call (gemini, exa,
elevenlabs) goes through one of two wrappers. One-shot calls use call(), which
wraps circuit breaker → retry → semaphore → timeout, in that order; streaming
calls use callStream() (below). Retry re-attempts only "curable" errors (transient 429/5xx) with
exponential backoff; "incurable" ones like 401 (bad key) are thrown immediately
so the user learns the cause.

```ts
const RETRYABLE = new Set([429, 500, 502, 503, 504]); // retry transient errors only

call<T>(fn: () => Promise<T>): Promise<T> {
  return this.breaker.run(() =>            // 1) circuit: a dead API fails fast, no call made
    withRetry(                             // 2) retry: transient errors only, 0.5s→1s→2s backoff
      () => this.semaphore.run(            // 3) semaphore: per-API concurrency cap (bulkhead)
        () => withTimeout(fn(), this.opts.timeoutMs, this.opts.label) // 4) timeout
      ),
      this.opts.label,
      this.retryDelays
    )
  );
}
```

The order matters. While backing off, a request holds no semaphore slot (retry
sits outside the semaphore), and a dead API is cut off by the outermost circuit
before any retry is even attempted.

Streaming uses callStream() instead: for a stream, the promise resolving means
"tokens start now," not "the call is done." So it holds the semaphore slot until
the stream is fully consumed — maxConcurrent then bounds generations in flight,
not just time to first byte — and counts a mid-stream failure (200 headers, then
an error chunk) as a circuit failure. Retry still covers only opening the stream;
calling again after tokens have shipped would duplicate text on screen. The
trade-off: unlike call(), the slot stays held through retry backoff too.

### Voice fallback

web/src/App.tsx — when server-side speech fails, the browser voice takes over.

```ts
const gen = ++voiceGenRef.current;                  // this request's generation
const blob = await requestVoice(answer, controller.signal);
if (gen !== voiceGenRef.current) return;            // stopped, or a new search started

if (blob) {
  new Audio(URL.createObjectURL(blob)).play();      // ElevenLabs mp3
} else {
  const u = new SpeechSynthesisUtterance(answer);   // browser built-in voice
  u.lang = "ko-KR";
  u.onend = () => setVoiceState("idle");
  u.onerror = () => setVoiceState("idle");          // else the button sticks on "stop"
  speechSynthesis.speak(u);
}
```

---

## Tech stack

- Frontend: React (Vite, TypeScript)
- Backend: Node.js + Express (TypeScript)
- Web search: Gemini built-in Google Search (default) or the Exa API
- LLM: Gemini `gemini-3.6-flash` (default) or OpenAI — runs on free tiers
- Voice input: Web Speech API (built into the browser)
- Voice output: ElevenLabs TTS + speechSynthesis fallback
- Resilience: hand-rolled Rate Limiter / Circuit Breaker / Bulkhead / cache (35 unit tests, node:test)
- Logging & observability: pino structured logs + in-memory metrics (p50/p95/p99) + live dashboard
- Load testing: custom SSE script + k6

## Limitations and next steps

- Speech recognition depends on the Web Speech API, so Chromium browsers only.
  Switching to the Whisper API would remove that limit but requires an
  upload-recordings architecture.
- Single-shot questions only (no multi-turn).
- Audio playback starts after the answer finishes generating. ElevenLabs'
  streaming API could pre-synthesize sentence-by-sentence and cut the wait to
  first sound.
- Deployed on Render's free tier (the server also serves the React build output).
