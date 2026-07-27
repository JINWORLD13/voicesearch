# STUDY.md — voicesearch 공부 노트

이 문서는 나 혼자 보는 공부 노트다. docs/PORTFOLIO.md는 남에게 보여줄 소개 문서이고,
이 파일의 목표는 다르다: 이 노트만 보고 코드를 안 보고도 처음부터 다시 칠 수 있는 것.
"이해했다"가 아니라 "손으로 다시 칠 수 있다"가 기준이다.

기술 스택: Express 5 + TypeScript(서버), React 19 + Vite(웹), 외부 API는 Exa(웹검색),
Gemini/OpenAI(LLM), ElevenLabs(TTS). DB 없음. 상태는 전부 인메모리.

---

## 0. 기획 — 코드 치기 전에 정하는 순서

무슨 문제를 푸나
사용자가 말(음성)이나 텍스트로 질문하면, 웹에서 최신 정보를 찾아 출처를 달아
음성으로 읽어주는 검색 앱. 부가로 "이 서버가 트래픽이 몰려도 안 죽는다"는 걸
숫자와 그래프로 보여주는 관리자 대시보드가 딸려 있다(이게 사실 이 프로젝트의
진짜 주제다 — 회복탄력성 계층을 실제로 만들고, 실제로 부하를 걸어 증명하는 것).

사용 시나리오
1. 사용자가 마이크를 누르고 질문을 말한다 (또는 텍스트로 입력)
2. 화면에 출처 목록이 뜨고, 답변이 한 글자씩 스트리밍된다
3. "읽어주기"를 누르면 그 답변을 음성으로 들려준다

안 할 것 (스코프)
- 로그인/계정 없음. 사용자를 구분하지 않는다(부하테스트에서 IP로만 구분)
- 대화 히스토리 저장 없음. 질문마다 완전히 독립적(멀티턴 대화 아님)
- 진짜 프로덕션 모니터링 도구가 아니다. runtimeConfig, 캐시, rate limiter가
  전부 프로세스 하나에 전역 상태로 있다 — 서버를 여러 대 띄우면 각자 따로 논다

데이터 흐름 두 줄
1. 질문 → (Exa 웹검색 또는 Gemini 내장검색) → 출처 목록 + LLM 스트리밍 답변(SSE)
2. 완성된 답변 텍스트 → ElevenLabs TTS → mp3 → 재생 (실패하면 브라우저 내장 음성)

뭘 저장할지
영속 저장소 없음. 전부 인메모리, 서버 재시작하면 날아간다 — 의도된 설계다.
- 답변 캐시: 최근 500개, 10분 TTL (LruTtlCache)
- rate limit 버킷: IP별 토큰버킷 (RateLimiter)
- 메트릭 카운터: 요청 수/지연/캐시적중 등 (Metrics)

기술 선택 (제약에서 출발)
- SSE를 EventSource 대신 fetch+ReadableStream으로 직접 파싱: 질문을 POST로
  보내야 하는데 EventSource는 GET만 지원해서
- 회복탄력성 계층(rate limiter/circuit breaker/bulkhead/cache)을 라이브러리
  없이 직접 구현: 이 프로젝트 자체가 "그 내부 동작을 보여주는" 게 목적이라
  블랙박스 라이브러리를 쓰면 의미가 없음
- 로깅만 예외적으로 라이브러리(pino) 사용: 비동기 flush/로그레벨 같은 건
  검증된 도구를 쓰는 게 맞다고 판단(재발명 안 함)
- MOCK_LLM 환경변수로 가짜 LLM을 씀: 진짜 Gemini는 무료 등급 rate limit이
  빡빡해서 초당 수십~수백 요청 같은 부하를 실제로 걸 수 없음

완료 기준
1. 정상 상태에서 검색 스트리밍 + 음성 재생이 끝까지 동작한다
2. MOCK_LLM=1로 띄우고 대시보드에서 "외부 AI 죽이기"를 누르면, 실패가 쌓여
   서킷이 open으로 바뀌고 이후 요청은 대기 없이 즉시 실패하는 게 그래프로 보인다
3. 부하 버튼(30연발/80동시)을 누르면 rate limit 429 카운터/동시실행 카운터가
   실제로 움직인다

---

## 1. 전체 지도

두 흐름으로 나눠서 본다.

A. 검색 요청 흐름 (사용자 입장)

| 칸 | 하는 일 | 파일 |
|----|---------|------|
| A1 | 텍스트 입력 또는 마이크로 말하기 | web/src/App.tsx |
| A2 | SSE로 서버에 질문 POST, 이벤트 파싱 | web/src/api.ts (streamSearch) |
| A3 | rate limit 통과 확인 | server/src/server.ts (rateLimit 미들웨어) |
| A4 | 캐시 확인 → 없으면 웹검색 | server/src/routes/search.ts, server/src/exa.ts |
| A5 | 출처 근거로 LLM이 답변 스트리밍 | server/src/llm.ts |
| A6 | 완료/에러 전송, 성공하면 캐시 저장 | server/src/routes/search.ts |
| A7 | 답변 완성 후 "읽어주기" → TTS | web/src/App.tsx, server/src/routes/voice.ts |

B. 방어/관측 흐름 (서버 내부 + 대시보드)

| 칸 | 하는 일 | 파일 |
|----|---------|------|
| B1 | IP별 토큰버킷으로 폭주 차단 | server/src/resilience/rateLimiter.ts |
| B2 | 외부 API 호출을 서킷브레이커로 감쌈 | server/src/resilience/circuitBreaker.ts |
| B3 | 동시 실행 수 제한(bulkhead) | server/src/resilience/semaphore.ts |
| B4 | 개별 호출에 타임아웃 | server/src/resilience/timeout.ts |
| B5 | 위 네 겹 + 재시도를 하나로 합침 | server/src/resilience/guard.ts, server/src/guards.ts |
| B6 | 과부하 시 기능을 단계적으로 포기 | server/src/runtimeConfig.ts, routes/search.ts, routes/voice.ts |
| B7 | 전부 숫자로 관측 | server/src/metrics.ts, server/src/server.ts (/api/metrics) |
| B8 | 실시간으로 보여주고 장애/부하를 주입 | web/src/Dashboard.tsx |
| B9 | 진짜 대량 부하로 검증 | loadtest/k6-throughput.js, k6-ratelimit.js, loadtest/run.mts |

---

## 2. 만드는 순서

| 순서 | 만드는 것 | 왜 이때 | 켜보기(성공 신호) |
|------|-----------|---------|---------------------|
| 1 | 순수 함수부터: TokenBucket, Semaphore, CircuitBreaker, withTimeout, LruTtlCache | 외부 의존성 없는 로직이라 유닛 테스트로 바로 검증됨 | `node --test`로 각 .test.ts 통과 |
| 2 | 네 겹을 합친 Guard 클래스 | 부품이 검증됐으니 조합 | 실패하는 fn을 넣어 재시도 → 서킷 open 확인 |
| 3 | Express 뼈대 + /api/health | 가장 단순히 살아있는지 확인 | curl로 200 |
| 4 | 검색 라우트: 캐시미스 → Exa → LLM 스트리밍(SSE) | 핵심 기능부터, 실제 키로 먼저 확인 | curl로 SSE 조각 확인 |
| 5 | rate limiter 미들웨어를 앞단에 배치 | 라우트가 도니 보호막 추가 | 같은 IP 연타 시 429 |
| 6 | mockLlm.ts + MOCK_LLM 환경변수 | 진짜 LLM은 느리고 쿼터 있어 부하 재현 불가 | MOCK_LLM=1로 띄워 2~6초 응답 확인 |
| 7 | metrics.ts + /api/metrics | 방어 계층이 일하는 걸 숫자로 봐야 함 | curl /api/metrics로 카운터 확인 |
| 8 | React 검색 화면(App.tsx) | 실제 사용 화면부터 | 브라우저에서 질문 → 스트리밍 확인 |
| 9 | 음성 인식 + TTS(+ 브라우저 폴백) | 핵심이 되니 부가기능 | 마이크로 질문, 읽어주기로 재생 확인 |
| 10 | Dashboard.tsx + runtimeConfig(장애 주입) | 관측 API가 있으니 보여줄 화면 추가 | 대시보드 숫자가 1초마다 갱신 |
| 11 | 부하 주입 버튼 + Graceful Degradation | 실제 부하에 방어 계층이 반응하는 걸 시연 | "외부 AI 죽이기" → 서킷 빨갛게 |
| 12 | loadtest/ 스크립트(k6, run.mts) | 브라우저 버튼은 최대 수십~백 동시가 한계라 진짜 대량 부하는 별도 | k6 run으로 429 비율/응답시간 리포트 |

---

## 3. 흐름별 코드

### A1~A2. 질문 보내고 SSE로 받기

상황: 사용자가 검색창에 질문을 넣고 제출하면, 서버로 POST를 보내고
응답을 스트림으로 읽어서 이벤트가 올 때마다 화면을 갱신한다.
파일: web/src/api.ts

```ts
export async function streamSearch(question: string, onEvent: (e: SearchEvent) => void) {
  const res = await fetch("/api/search", {
    method: "POST", // EventSource는 GET만 되니까 fetch로 직접 스트림을 읽는다
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "요청에 실패했습니다.");
  }

  // res.body는 ReadableStream. getReader()로 조각(청크)을 하나씩 꺼낸다
  const reader = res.body.getReader();
  const decoder = new TextDecoder(); // 청크는 바이트(Uint8Array)라서 문자열로 바꿔야 함
  let buffer = ""; // 네트워크는 이벤트 경계랑 무관하게 잘려서 온다. 여기 쌓아둔다

  while (true) {
    const { done, value } = await reader.read();
    if (done) break; // 서버가 res.end() 했으면 done=true
    buffer += decoder.decode(value, { stream: true });

    // SSE 이벤트 구분자는 빈 줄(\n\n). 그걸로만 잘라도 되는 이유는
    // 서버가 항상 "data: {...}\n\n" 형태로 한 이벤트씩 끊어 보내기 때문
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? ""; // 마지막 조각은 아직 미완성일 수 있어 다음 턴으로 넘김

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      onEvent(JSON.parse(line.slice(5))); // "data: " 6글자(공백 포함) 자르고 JSON 파싱
    }
  }
}
```

데이터 모양: 이진 청크(Uint8Array) → 문자열 버퍼 → `["data: {...}", "data: {...}", ""]`
(split 결과) → 마지막 `""`은 buffer로 남기고, 나머지는 JSON.parse해서 콜백으로.

왜 REST처럼 "요청 1개 = 응답 1개"가 아닌가: 이건 스트림이라 한 번의 POST에
이벤트가 여러 번(sources 1번 + delta N번 + done/error 1번) 온다. while(true)
루프가 있는 이유가 바로 이거다 — 응답이 끝날 때까지(done=true) 계속 읽어야 함.

### A3. rate limit 통과

상황: 서버가 요청을 받자마자, 라우트 로직을 타기 전에 이 IP가 너무 자주
오지 않았는지 확인한다.
파일: server/src/server.ts

```ts
function clientKey(req: express.Request): string {
  // X-Forwarded-For가 있으면 그걸 우선(프록시 뒤 실제 IP, 부하 스크립트가 이 헤더로
  // 가상 사용자를 흉내낸다). 없으면 소켓 IP.
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res, next) {
  metrics.inc("ingress.total"); // 통과/거부 여부와 무관하게 "들어온 시도"를 여기서 센다
  if (runtimeConfig.rateLimitEnabled && !rateLimiter.allow(clientKey(req))) {
    metrics.inc("ingress.rateLimited");
    // 503(서버 잘못)이 아니라 429(너무 자주 보냄) — 클라이언트가 백오프 후
    // 재시도하면 되는 정상 신호라는 뜻
    return res.status(429).json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." });
  }
  next(); // 통과 → 다음(검색/음성 라우터)으로
}

// 검색과 음성 둘 다 같은 미들웨어를 쓴다 → 같은 IP면 같은 버킷을 공유한다
app.use("/api/search", rateLimit, searchRouter);
app.use("/api/voice", rateLimit, voiceRouter);
```

여기서 중요한 지점: `ingress.total`은 rate limit 판정 "전"에 찍히고,
search.ts의 `requests.total`은 판정을 "통과한 뒤"에 찍힌다. 이 위치 차이를
알아야 나중에 메트릭 숫자를 해석할 수 있다(5번 절에서 다시 나옴).

### A4~A6. 캐시 → 웹검색 → LLM 스트리밍 → 캐시 저장

상황: rate limit을 통과한 요청이 실제로 답을 만드는 자리. 캐시 히트면
LLM을 아예 안 부르고, 미스면 Exa로 검색한 뒤 그 결과를 근거로 LLM이 스트리밍한다.
파일: server/src/routes/search.ts

```ts
router.post("/", async (req, res) => {
  metrics.inc("requests.total"); // rate limit "통과 후" 카운트(ingress.total과 다른 지점)

  // SSE 헤더는 여기서 바로 연다. 캐시 조회/LLM 호출 전에 헤더부터 보내야
  // 클라이언트가 "연결됐다"는 걸 즉시 안다 (이후 res.write로 이벤트를 흘려보냄)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.flushHeaders?.();

  let clientGone = false;
  res.on("close", () => { clientGone = true; }); // 사용자가 탭을 닫거나 취소하면 표시만

  const send = (data) => { if (!clientGone) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  // 1) 캐시 히트면 여기서 끝. 5~7초짜리 LLM 호출을 통째로 건너뛴다
  const key = cacheKey(question); // 공백 정리 + 소문자화로 "같은 질문"을 넓게 인정
  const cached = answerCache.get(key);
  if (cached) {
    metrics.inc("requests.cacheHit");
    send({ type: "sources", sources: cached.sources });
    for (const piece of replayChunks(cached.answer)) send({ type: "delta", text: piece });
    send({ type: "done", elapsedMs: Date.now() - started, cached: true });
    return res.end();
  }

  // 2) 미스 → Exa 웹검색 → 그 결과를 프롬프트에 넣어 LLM 스트리밍
  const results = await searchWeb(question); // exa.ts, exaGuard로 감싸져 있음
  send({ type: "sources", sources: sourcesPayload });
  for await (const text of streamAnswer(question, results)) { // llm.ts
    answer += text;
    send({ type: "delta", text });
  }

  send({ type: "done", elapsedMs: Date.now() - started });
  metrics.inc("requests.success");
  // 3) 성공하고 답이 비어있지 않을 때만 캐시에 넣는다(중간에 끊긴 반쪽 답은 저장 안 함)
  if (answer.trim() && !clientGone) answerCache.set(key, { answer, sources: sourcesPayload, path });
});
```

데이터 모양: `question(문자열)` → `SearchResult[](Exa 결과 5개)` → 프롬프트 문자열
1개(출처를 다 이어붙임) → LLM이 조각조각 뱉는 텍스트 스트림 → 클라이언트에
`{type:"delta", text:"..."}`로 한 조각씩.

### B1~B5. 회복탄력성 네 겹(Guard)

상황: Exa/Gemini/OpenAI/ElevenLabs 같은 외부 API를 부를 때마다 "혹시 죽었나
(서킷) → 일시적 오류면 다시(재시도) → 동시에 너무 많이 부르지 않게(세마포어)
→ 너무 오래 안 기다리게(타임아웃)"를 매번 손으로 안 쓰려고 하나로 합친 것.
파일: server/src/resilience/guard.ts

```ts
call<T>(fn: () => Promise<T>): Promise<T> {
  return this.breaker.run(() =>        // 제일 바깥: 회로 열려있으면 fn 자체를 안 부름
    withRetry(                          // 그 안: 429/5xx면 delays만큼 쉬었다 재시도
      () => this.semaphore.run(() =>    // 그 안: 실제 "실행 순간"에만 자리를 잡음
        withTimeout(fn(), this.opts.timeoutMs, this.opts.label) // 제일 안: 상한시간
      ),
      this.opts.label,
      this.retryDelays
    )
  );
}
```

겹 순서가 이런 이유(밖→안): 회로가 열려있으면 재시도/세마포어/타임아웃 전부
의미가 없으니(어차피 안 부를 거니까) 제일 밖에 둔다. 세마포어는 재시도 "각
시도마다" 자리를 새로 잡아야 하니(백오프로 쉬는 동안은 자리를 놓아줘야
다른 요청이 그 자리를 씀) 재시도보다 안쪽. 타임아웃은 실제 호출 한 번
한 번에 걸어야 하니 제일 안쪽.

실제 사용: server/src/guards.ts에 의존성마다 값을 다르게 설정한다.

```ts
export const geminiGuard = new Guard({
  label: "gemini", maxConcurrent: 8, timeoutMs: 30000,
  failureThreshold: 5, resetMs: 10000, retryDelays: [500, 1000, 2000],
});
export const elevenLabsGuard = new Guard({
  // ElevenLabs는 무료 한도가 작고, 실패해도 브라우저 음성으로 폴백되니
  // 서킷을 더 예민하게(failureThreshold 낮게) 잡아도 사용자 경험이 안 깨진다
  label: "elevenlabs", maxConcurrent: 4, timeoutMs: 30000,
  failureThreshold: 4, resetMs: 15000, retryDelays: [500, 1000, 2000],
});
```

### B6. Graceful Degradation

상황: 과부하일 때 "다 살리기"가 아니라 덜 중요한 것부터 순서대로 포기한다.
파일: server/src/routes/search.ts, server/src/routes/voice.ts

```ts
// search.ts — 캐시 조회 "다음"에 체크한다(캐시 히트는 이미 위에서 처리했으니
// 여기 도달했다는 건 새 외부 호출이 필요하다는 뜻)
if (runtimeConfig.degradation === "reject") {
  send({ type: "error", message: "지금 요청이 많아 검색을 잠시 제한하고 있어요." });
  return res.end();
}
if (runtimeConfig.degradation === "cache-only") {
  send({ type: "error", message: "지금은 이미 검색된 질문만 답할 수 있어요." });
  return res.end();
}

// voice.ts — TTS는 제일 무겁고 제일 덜 핵심이라 "none이 아니면" 무조건 포기
if (runtimeConfig.degradation !== "none") {
  return res.status(503).json({ error: "지금은 음성 합성을 잠시 중단했어요." });
}
```

포기 순서(1단계→3단계): no-tts(음성만 포기) → cache-only(새 검색 거부, 캐시된
것만) → reject(검색 자체 거부). 숫자가 아니라 문자열 레벨로 관리하는 이유는
대시보드 버튼이 그 레벨을 그대로 보내기 때문(inject({degradation: "reject"})).

### B7~B8. 메트릭 노출과 대시보드

상황: 위에서 쌓인 카운터들을 JSON 하나로 모아 보여주고, 대시보드가 1초마다
그걸 읽어 그래프를 그린다.
파일: server/src/server.ts, web/src/Dashboard.tsx

```ts
// server.ts — 여러 출처의 상태를 한 응답에 모은다(카운터 + 캐시 + 가드4개 + rate limiter)
app.get("/api/metrics", (_req, res) => {
  res.json({
    ...metrics.snapshot(),
    cache: cacheStats(),
    guards: guardMetrics(), // { gemini:{...}, openai:{...}, exa:{...}, elevenlabs:{...} }
    rateLimiter: { trackedKeys: rateLimiter.trackedKeys, config: {...} },
    degradation: runtimeConfig.degradation,
  });
});
```

```tsx
// Dashboard.tsx — 1초마다 폴링해서 최근 60개(=60초)만 그래프에 남긴다
useEffect(() => {
  let alive = true;
  const tick = async () => {
    const m = await fetchMetrics();
    if (!alive) return;
    setMetrics(m);
    // 순간 요청률(rate)은 서버가 안 줌 — 클라이언트가 두 시점의 누적치 차이로 직접 계산
    const total = m.counters["ingress.total"] ?? 0;
    const now = Date.now();
    let rate = 0;
    if (prevRef.current) {
      const dt = (now - prevRef.current.t) / 1000;
      rate = dt > 0 ? Math.max(0, (total - prevRef.current.total) / dt) : 0;
    }
    prevRef.current = { total, t: now };
    setSeries((s) => [...s.slice(-59), { p50: m.latency.p50, p95: m.latency.p95, rate }]);
  };
  const id = setInterval(tick, 1000);
  tick();
  return () => { alive = false; clearInterval(id); }; // 컴포넌트가 사라질 때 폴링도 멈춤
}, []);
```

데이터 모양: 누적 카운터(`ingress.total: 63`) → 두 시점 차이 ÷ 경과시간 →
순간 요청률(`rate: 2.3/s`) → 최근 60개만 남긴 배열(series) → SVG 꺾은선.

실제로 겪은 버그: App.tsx에서 원래 `{view === "dashboard" && <Dashboard />}`처럼
조건부 렌더링을 했었다. 이러면 "검색" 탭으로 갔다가 "대시보드"로 돌아올 때마다
Dashboard가 언마운트→재마운트되고, 그 안의 series/metrics/busy state가 전부
초기화된다(useEffect의 setInterval도 끊겼다 다시 시작). 부하 주입 중(busy="burst")에
탭을 바꾸면 실제 서버 작업은 계속되는데 busy만 null로 리셋되는 문제도 있었다.
고친 방법: 언마운트하는 대신 `style={{ display: view === "dashboard" ? "block" : "none" }}`로
숨기기만 함 — DOM은 그대로 살아있고 CSS로만 안 보이게 하니 state/폴링이 안 끊긴다.
→ React에서 "안 보이게 하기"와 "없애기"는 다르다. 조건부 렌더링(`&&`)은 후자다.

---

## 4. 왜 그렇게 하나

| 선택 | 이유 |
|------|------|
| Token Bucket (Fixed/Sliding Window, Leaky Bucket 대신) | 검색처럼 "가끔 몰아치지만 평균은 낮은" 트래픽에 맞음. 순간 버스트(capacity까지)는 봐주고 지속 요청은 refill 속도로만 제한 |
| 토큰을 타이머로 안 채우고 지연계산 | 요청마다/버킷마다 타이머를 돌리면 낭비. "마지막 채운 시각~지금" 사이 흐른 시간만큼만 계산해서 채움 |
| Guard 겹 순서: 서킷→재시도→세마포어→타임아웃 | 서킷 열려있으면 나머지가 다 무의미(밖에 둠). 세마포어는 재시도 "각 시도"마다 자리를 다시 잡아야 함(재시도 안쪽) |
| 캐시를 LRU+TTL 둘 다 | LRU만으로는 "오래돼서 낡은 웹 검색 결과"를 못 거름. TTL만으로는 메모리 상한이 안 잡힘 |
| LRU를 Map 재삽입으로 구현 | JS Map은 삽입 순서를 기억한다. 지웠다 다시 넣으면 그 항목이 맨 뒤(최신)로 가고, 맨 앞이 자동으로 "가장 오래 안 쓴 것"이 됨 — 별도 연결리스트 없이 구현 |
| MOCK_LLM이 지연을 "스트림을 여는 순간"에 넣음(토큰 나오는 도중이 아니라) | 실제 generateContentStream도 첫 응답까지 기다리다 실패할 수 있어서, guard의 타임아웃/재시도/서킷이 진짜와 똑같은 지점에서 개입하게 하려고 |
| 검색과 음성이 같은 rate limit 버킷 공유 | 음성을 따로 빼면 반복 호출만으로 ElevenLabs 월 무료 한도를 고갈시킬 수 있음(세마포어는 동시성만 막지 총량은 못 막음) |
| 429(서버에러 503이 아니라) | 서버는 멀쩡하고 "네가 너무 많이 보냈다"는 뜻 — 클라이언트가 백오프 후 재시도하면 되는 정상 신호 |
| ADMIN_TOKEN으로 관리 엔드포인트 보호 | 공개 배포 시 누구나 rate limiter를 끄거나 degradation=reject로 검색 전체를 중단시킬 수 있어서(CORS는 브라우저만 막지 curl은 못 막음) |

---

## 5. 헷갈리는 것

### TokenBucket 숫자로 추적하기 (capacity=5, refillPerSec=2)

| 시각(s) | 이벤트 | 계산 | tokens 이후 |
|---------|--------|------|-------------|
| 0.0 | 시작 | - | 5.0 |
| 0.0 | 요청 5번 연달아 | 5→4→3→2→1→0 | 0.0 |
| 0.0 | 6번째 요청 | 경과 0초, refill 없음, 0<1 | 거부(429), 0.0 |
| 0.5 | 7번째 요청 | 경과 0.5s×2=+1.0 → 1.0, 소비 | 0.0 |
| 1.0 | 8번째 요청 | 경과 0.5s×2=+1.0 → 1.0, 소비 | 0.0 |

읽는 법: 처음엔 5개까지 몰아서 통과되고(버스트 허용), 그 이후로는
"초당 2개"라는 지속 속도로만 통과된다.

### Semaphore 넘겨주기 (max=2, 요청 A,B,C,D,E 동시 도착)

| 순서 | 상태 |
|------|------|
| A,B acquire | permits 2→1→0, 둘 다 즉시 실행 |
| C,D,E acquire | permits=0 → 셋 다 큐에 대기 |
| A 끝, release() | 큐에서 C를 꺼내 바로 실행시킴(permits는 안 늘림, 그 자리를 그대로 C한테 넘김) |
| B 끝, release() | 큐에서 D를 꺼내 실행 |
| C 끝, release() | 큐에서 E를 꺼내 실행 |
| D 끝, release() | 큐 비었음 → permits++ (0→1) |
| E 끝, release() | 큐 비었음 → permits++ (1→2, 원상복구) |

헷갈리는 지점: release()가 대기자가 있을 때는 permits를 안 늘리고 그냥
다음 사람에게 "자리를 넘긴다". 대기자가 없을 때만 permits를 실제로 늘린다.

### CircuitBreaker 상태 전이 (failureThreshold=3, resetMs=10000)

| 상태 | 이벤트 | 결과 |
|------|--------|------|
| closed, failures=0 | 성공 | closed, failures=0 |
| closed | 실패 | failures=1, 계속 closed |
| closed | 실패 | failures=2, 계속 closed |
| closed | 실패 | failures=3, 3>=3 → open, openedAt=now |
| open | 요청 (10초 안 지남) | fn() 안 부름, 즉시 CircuitOpenError |
| open | 10초 지난 후 요청 | half-open으로 바꾸고 이번엔 실제로 fn() 호출 |
| half-open | 성공 | closed, failures=0 |
| half-open | 실패 | 바로 다시 open(임계치 재확인 없이 1번 실패로 바로) |

### 메서드 넣으면→나오면

| 메서드 | 넣으면 | 나오면 |
|--------|--------|--------|
| Guard.call(fn) | 실패할 수 있는 비동기 함수 | fn 성공 결과, 실패 시 CircuitOpenError/TimeoutError/원래 에러 |
| CircuitBreaker.run(fn) | fn | fn 결과, open이면 fn 호출 자체를 안 하고 즉시 에러 |
| Semaphore.run(fn) | fn | fn 결과, 자리 없으면 대기 후 실행(에러 아님, 늦게 실행될 뿐) |
| withTimeout(promise, ms) | 이미 시작된 promise | 그 결과, ms 안에 안 끝나면 TimeoutError(원래 promise를 취소하진 못함) |
| LruTtlCache.get(key) | 문자열 키 | 값 또는 undefined. 있으면 부수효과로 순서를 맨 뒤로 옮김 |
| LruTtlCache.set(key, value) | 키, 값 | void. 부수효과로 상한 넘으면 가장 오래된 것 삭제 |

### API 응답 봉투

`/api/search`는 REST가 아니라 SSE라 "봉투"가 없다. `data: {...}\n\n` 줄이
여러 번 온다. 순서는 항상 `sources 1번 → delta N번 → done 또는 error 1번`.
즉 "요청 1개 = 응답 1개"가 아니라 "요청 1개 = 이벤트 N+2개"다.

`/api/metrics`는 진짜 REST. 봉투 구조:
```
{ counters:{...}, latency:{p50,p95,p99,max}, cache:{...},
  guards:{ gemini:{circuit,inUse,queued}, openai:{...}, exa:{...}, elevenlabs:{...} },
  rateLimiter:{...}, degradation:"..." }
```
Dashboard.tsx는 이걸 두 겹으로 벗긴다: 최상위 metrics 객체 한 겹, 그 안
counters 맵에서 특정 키(`c["ingress.total"]`) 한 겹.

### 메트릭 리셋 타이밍 착시

"메트릭 초기화"를 누른 시점에 이전 요청들(mock 지연 9~13초짜리)이 아직
진행 중이면, 그 요청들의 `requests.success`/`cacheHit` 증가는 리셋 "이후"
카운터에 더해진다. 반면 그 요청들의 `ingress.total` 증가는 이미 리셋 "이전"에
찍혀서 지워진 뒤다. 그 결과 한동안 "처리(served)" 숫자가 "총 유입(ingress)"
보다 커 보일 수 있다 — 버그가 아니라 리셋과 비동기 작업 완료 시점이 어긋난
것뿐이고, 오래된 요청들이 다 빠지면 다시 맞아떨어진다.

---

## 6. 검색해서 쓸 것

프레임워크/외부 SDK 보일러플레이트라 외울 필요 없음. 필요할 때 문서 찾으면 됨.

- Express 5 라우터/미들웨어 문법, cors 패키지 옵션
- dotenv 사용법
- pino 로거 API (child logger, level)
- axios 옵션(timeout, responseType: "arraybuffer" 등)
- @google/genai SDK (GoogleGenAI, generateContentStream, config.tools.googleSearch)
- openai SDK (chat.completions.create stream)
- React 19 훅 기본기(useState/useEffect/useRef) 자체 문법
- Vite 프로젝트 설정/빌드
- Web Speech API (SpeechRecognition/webkitSpeechRecognition), SpeechSynthesisUtterance
- ElevenLabs REST API 스펙(엔드포인트, voice_id)
- k6 executor 종류(constant-arrival-rate 등), k6 옵션 문법

---

## 7. 외울 것 (이 프로젝트 고유 로직)

- TokenBucket의 지연계산 리필 공식(경과시간 × refillPerSec)
- Semaphore.release()가 대기자 있으면 permits를 안 늘리고 바로 넘기는 이유
- CircuitBreaker 3상태(closed/open/half-open) 전이 규칙
- Guard의 4겹 순서(서킷→재시도→세마포어→타임아웃)와 그 순서인 이유
- LRU를 별도 연결리스트 없이 Map 재삽입으로 구현하는 트릭
- SSE 파싱: 버퍼에 쌓고 `\n\n`으로 split, 마지막 조각은 항상 보류
- ingress.total(rate limit 판정 "전")과 requests.total(판정 "후")의 위치 차이
- mockLlm이 지연을 스트림 오픈 시점에 넣는 이유(guard가 실제와 같은 지점에서 개입하게)
- React 조건부 렌더링(`&&`, unmount)과 `display:none`(hidden)의 차이 —
  state/타이머를 유지하려면 후자를 써야 함

---

## 8. 자가 점검

막히면 옆에 적은 절로 돌아간다.

1. 같은 질문을 10분 안에 두 번 물으면 서버에서 무슨 일이 일어나는지, 어느
   파일의 몇 번째 분기를 타는지 설명할 수 있나? (→ 3번 A4~A6)
2. IP 하나가 1초에 20번 요청을 쏘면 몇 번째부터 429가 뜨는지, capacity/refill
   숫자로 직접 계산할 수 있나? (→ 5번 TokenBucket 표)
3. Gemini 서킷이 열려있는 도중 들어온 요청이 실제로 네트워크 요청을 보내는지
   안 보내는지, 어느 코드가 그걸 막는지 짚을 수 있나? (→ CircuitBreaker.run)
4. 30개 동시 요청이 maxConcurrent=8인 가드를 통과할 때, 9번째 요청은 정확히
   언제 실행되기 시작하는지 설명할 수 있나? (→ Semaphore 표)
5. "대시보드"와 "검색" 탭을 오가도 그래프가 안 사라지게 만든 방법이 뭐고,
   원래는 왜 사라졌었는지 설명할 수 있나? (→ B7~B8 실제 버그 절)
6. 부하 도중 "메트릭 초기화"를 누르면 숫자가 이상해 보일 수 있는 이유를
   설명할 수 있나? (→ 5번 메트릭 리셋 타이밍 착시)
7. degradation을 reject로 바꾸면 캐시 히트도 막히는지, 캐시는 여전히 되는지
   코드로 짚을 수 있나? (→ B6, A4~A6)
8. 이 프로젝트를 완전히 새 폴더에서 처음부터 짠다면, 2번 표를 안 보고 순서를
   말할 수 있나?
