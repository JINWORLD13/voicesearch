[한국어](README.md) | [日本語](README.ja.md) | **English**

# VoiceSearch

**Live demo**: https://voicesearch-cwh9.onrender.com (free Render tier — the first request may be slow)

Ask a question out loud and VoiceSearch searches the web, answers with sources,
and reads the answer back to you. Built with React, Express (TypeScript), and the
Gemini API. Search runs on the Exa API or Gemini's built-in Google Search, and
speech synthesis uses ElevenLabs with the browser's built-in voice as a fallback.

![Search view — sources appear first, the answer streams in, then it is read aloud](docs/screenshots/search.png)

## Why I built it

An LLM knows nothing after its training cutoff. In a previous project (DocChat, a
document-upload RAG chatbot) I practiced the pattern of "hand the model evidence
and make it answer only from that evidence." This time I swapped the evidence
source from uploaded documents to live web search, then put voice recognition on
the way in and speech synthesis on the way out — aiming for a search you can use
without keeping your eyes on the screen.

## How it works

```
Mic button → the browser's Web Speech API turns speech into text (interim results shown live)
  → when the utterance ends, it automatically POSTs /api/search
  → if EXA_API_KEY is set
      Exa web search, 5 results → the source list is sent first
      → results go into the prompt → generation streams token-by-token over SSE
  → if not
      Gemini's built-in Google Search (grounding) does search + generation in one call
      → the answer streams → referenced pages arrive as sources

"Read aloud" button → POST /api/voice → ElevenLabs generates an mp3 → playback
  → if the key is missing or the call fails, falls back to the browser's speechSynthesis
```

## What I paid attention to

### An answer that will be spoken needs a different prompt

The answer appears on screen, but it ultimately gets read out loud. So the prompt
bans Markdown formatting and demands sentences that sound natural when spoken.
In practice the model writes "2.9 percent" instead of "2.9%". Citation markers
like [1] are needed on screen but sound awkward when read aloud, so the server
strips them before sending the text to TTS.

### If a key is missing, run on what's available

I didn't want the demo to die just because an external key wasn't ready, so every
paid/external API has an alternative path. Search falls back from Exa to Gemini's
built-in Google Search; speech synthesis falls back from ElevenLabs (whether the
key is missing or the quota is exhausted) to the browser's built-in
speechSynthesis. As a result, the entire app runs on a single GEMINI_API_KEY.
The UI shows which voice is currently playing, and text sent to TTS is cut at
600 characters to conserve the ElevenLabs free plan (10k credits/month).

### Sources are sent before the answer

On the Exa path, as soon as search finishes, the five sources (title, domain,
date) are pushed down first — only then does generation start. While waiting for
the answer you can already see what it will be based on, which makes the wait
feel shorter. Sentences end with [1], [2] markers showing which source they used,
and when sources disagree the prompt prefers the more recent date. The built-in
search path does search and generation in one call, so the order is reversed
(answer streams first, sources arrive last) — the frontend renders purely by
event type, so it handles both orders.

### Swappable LLM providers

Gemini and OpenAI switch with a single .env value (LLM_PROVIDER). The two SDKs
stream in different shapes, so both are wrapped as "an async generator that
yields text chunks" — route code never knows which provider is attached.
Transient errors like 429/5xx are retried with exponential backoff; errors like
401 (bad key) are not retried and the user is told the cause immediately.

### Search fires the moment you stop talking

Interim speech-recognition results stream into the input field in real time, and
when the browser decides the utterance is over, the final text triggers the
search immediately — no second button press. The Web Speech API only exists in
Chromium-based browsers, so on unsupported browsers the mic button is hidden and
text search remains.

### Four layers of defense against overload and failure

This server wraps a slow, unstable external AI, so I framed the core problem as
"survive when the outside wobbles" rather than "process more." Rate Limiter
(hand-rolled Token Bucket) → Circuit Breaker → Bulkhead (per-API semaphores) →
Graceful Degradation, plus cache, retries, and timeouts. The alternatives
comparison behind each decision and the measured load-test results (cache p50
3905→1ms, the circuit halving wall-clock time under failure, and more) are in
[docs/RESILIENCE.en.md](docs/RESILIENCE.en.md). You can inject failures from the
dashboard and watch the defenses fire in real time, and injected settings
auto-revert 10 minutes after the last change (so a visitor who walks away can't
leave the demo polluted).

![Dashboard after "kill the external AI" — the circuit opens (80 short-circuited), 429s and aborts are counted, and the event log records the circuit opening](docs/screenshots/dashboard.png)

## Tech stack

- Frontend: React (Vite, TypeScript)
- Backend: Node.js + Express (TypeScript)
- Web search: Gemini built-in Google Search (default) or the Exa API
- LLM: Gemini API `gemini-3.6-flash` (default) or OpenAI — runs on free tiers
- Voice input: Web Speech API (built into the browser)
- Voice output: ElevenLabs TTS + speechSynthesis fallback
- Logging: pino (structured JSON logs)
- Load testing: custom script + k6

## Running it

1. Server

```bash
cd server
cp .env.example .env   # only GEMINI_API_KEY is required (Exa and ElevenLabs are optional)
npm install
npm run dev            # http://localhost:3001
```

2. Frontend

```bash
cd web
npm install
npm run dev            # http://localhost:5173
```

Open it in Chrome, press the mic button, and ask something like "What's the
minimum wage in 2026?". It works without ELEVENLABS_API_KEY (falls back to the
browser voice).

3. Tests (26 resilience-utility tests, including the four-layer guard composition)

```bash
cd server && npm test
```

4. Load test / dashboard demo (measures only the server layer, no external LLM)

```bash
# demo server: the external LLM is replaced by a slow, occasionally failing mock
cd server && MOCK_LLM=1 MOCK_LLM_MIN_MS=300 MOCK_LLM_MAX_MS=1000 npm start
# in another terminal, apply load (concurrency 50, 200 requests total)
npx tsx loadtest/run.mts 50 200
# open the frontend and inject failures/load from the dashboard tab
```

## Project layout

```
server/
  src/
    server.ts        Express app, rate limiter (search + voice), metrics/injection endpoints (ADMIN_TOKEN-protected)
    exa.ts           Exa web search (wrapped in exaGuard)
    llm.ts           Gemini/OpenAI streaming generation, built-in search (grounding) path
    guards.ts        Per-external-API protection (circuit + retry + semaphore + timeout)
    runtimeConfig.ts Runtime failure-injection settings (adjusted by the dashboard)
    mockLlm.ts       Fake LLM for load testing (slow, probabilistically failing)
    logger.ts        pino structured logging
    metrics.ts       In-memory metrics (p50/p95/p99, counters)
    sse.ts           Pure SSE-parsing function (+ tests)
    resilience/
      timeout.ts, semaphore.ts, cache.ts, circuitBreaker.ts,
      rateLimiter.ts, guard.ts   (each with its .test.ts)
    routes/
      search.ts      Rate limit → cache → path selection → SSE, logging/metrics/degradation
      voice.ts       ElevenLabs TTS proxy (dropped first under degradation)
web/
  src/
    api.ts           fetch + SSE parsing, metrics/injection/load firing
    App.tsx          Speech recognition, search view, playback and fallback, tab switching
    Dashboard.tsx    Live metric charts + failure/load injection controls
loadtest/
  run.mts            Custom load script (reads SSE to done, aggregates per scenario)
  k6-throughput.js   k6: ramping load, verifies safe 429 rejection
  k6-ratelimit.js    k6: one user flooding → rate-limiter block rate
docs/
  RESILIENCE.md      The four-layer defense as PAR (problem–alternatives–action–results)
  PORTFOLIO.md       Architecture and technology-choice overview
  *.ja.md / *.en.md  Japanese and English versions of the docs (including README)
```

## Limitations and what's next

- Speech recognition depends on the Web Speech API, so it only works in
  Chromium-based browsers. Switching to an STT API like Whisper would remove
  that limit, but it requires uploading recordings to the server — left as a
  next step.
- Single-shot questions only; there is no multi-turn memory of earlier questions.
- Audio playback starts only after the full answer is generated. ElevenLabs'
  streaming API could synthesize sentence-by-sentence and cut the wait until the
  first sound.
- On the built-in search path, source links arrive as Google redirect URLs, the
  number of results and body excerpts can't be controlled, and inline [1]
  markers can't be attached to the answer. Use the Exa path when that control
  matters.
- Deployed on Render's free tier (Express serves the React build output as well).
