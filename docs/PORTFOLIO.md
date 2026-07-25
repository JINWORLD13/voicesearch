**한국어** | [日本語](PORTFOLIO.ja.md)

# VoiceSearch

말로 물어보면 웹을 검색해서 근거와 함께 답하고, 그 답을 음성으로 읽어주는
검색 서비스. 신입 개발자 포트폴리오로 만들었음.

한 줄 요약: 음성 입력 → 웹 검색 → LLM이 근거 기반 답변을 스트리밍 → 음성 출력.
외부 API 키가 없어도 대체 경로로 동작하도록 설계했음.

---

## 데모

라이브 링크: (배포 예정 — Render + Netlify)

스크린샷과 데모 영상은 배포와 함께 `docs/screenshots/`에 추가 예정.
로컬 실행 방법은 [README](../README.md#실행-방법)에 있음.

---

## 아키텍처

```
┌─────────────────────────────────────────────┐
│  브라우저 (React + TypeScript, :5173)          │
│                                               │
│  마이크 ── Web Speech API ──▶ 텍스트           │
│                                 │             │
│  화면 ◀── SSE 이벤트 파싱 ◀──────┤             │
│  (출처 카드 / 답변 스트리밍)      │             │
│                                 ▼             │
└─────────────────────────────┬─────────────────┘
                              │ POST /api/search
                              │ POST /api/voice
                              ▼
┌─────────────────────────────────────────────┐
│  서버 (Express + TypeScript, :3001)            │
│                                               │
│  routes/search.ts  ── 검색 경로 선택 (지휘자)   │
│       │                                       │
│       ├─ EXA_API_KEY 있음 ─▶ exa.ts           │
│       │                      (웹 검색 5건)     │
│       │                         │             │
│       │                         ▼             │
│       │                     llm.ts            │
│       │                  (Gemini/OpenAI 생성)  │
│       │                                       │
│       └─ 없음 ─▶ llm.ts (Gemini 내장 구글 검색) │
│                                               │
│  routes/voice.ts ── ElevenLabs TTS 프록시      │
└─────────────────────────────┬─────────────────┘
                              │
                  ┌───────────┼───────────┐
                  ▼           ▼           ▼
              Gemini API   Exa API   ElevenLabs API
             (검색+생성)   (웹검색)    (음성합성)
```

데이터 흐름 한 줄:
질문 텍스트 → (검색) → 검색결과 → (LLM) → 답변 조각 → SSE → 화면 → (선택) mp3

---

## 기술 선택 이유

### 왜 검색 경로를 두 개(Exa / Gemini 내장 검색)로 두었나

처음엔 Exa 검색 API 하나만 썼음. 그런데 Exa는 가입과 API 키 발급이 필요해서,
이 앱을 처음 켜는 사람이 키 없이는 아무것도 못 보는 문제가 있었음.

Gemini에는 내장 구글 검색(grounding) 기능이 있음. 그래서 Exa 키가 없으면
Gemini가 스스로 검색해서 답하는 경로로 자동 전환하게 했음. 결과적으로
GEMINI_API_KEY 하나만 있으면 전체 기능이 돌아감.

둘의 트레이드오프:

| | Exa 경로 | Gemini 내장 검색 |
|---|---|---|
| 필요한 키 | Exa + Gemini | Gemini 하나 |
| 검색 결과 제어 | 개수, 본문 발췌 직접 제어 | 제어 불가 |
| 출처 링크 | 원본 URL | 구글 리다이렉트 URL |
| 답변 내 [1] 번호 | 가능 | 불가 |

세밀한 제어가 필요하면 Exa, 간편함이 우선이면 내장 검색. 상황에 맞게 고르게 뒀음.

### 왜 LLM 프로바이더를 Gemini/OpenAI 둘 다 지원하나

특정 회사 API에 묶이지 않게 하려고 .env 값 하나(LLM_PROVIDER)로 바꾸게 했음.
두 SDK는 스트리밍 응답 모양이 다른데, 둘 다 "텍스트 조각을 내보내는
async generator"로 감싸서 라우트 코드는 어느 쪽인지 몰라도 되게 통일했음.

### 왜 SSE인가 (WebSocket 아니고)

답변 생성에 4~7초가 걸림. 다 만들고 한 번에 주면 그동안 빈 화면임.
서버가 조각을 만들어지는 대로 흘려보내면 글자가 차오름.

방향이 서버→클라이언트 단방향뿐이라 SSE로 충분함. SSE는 그냥 HTTP라
WebSocket보다 단순함. 양방향(예: 생성 중단 신호)이 필요해지면 그때
WebSocket을 고려함.

### 왜 음성은 폴백을 두었나

ElevenLabs 무료 플랜은 월 1만 자 제한이라 언제든 한도에 걸릴 수 있음.
음성 생성이 실패하면 브라우저 내장 음성(speechSynthesis)으로 대신 읽음.
데모 중 API 한도 때문에 소리가 안 나는 상황을 없애기 위한 설계임.

---

## 부딪힌 문제와 해결

### 1. 외부 검색 API가 진입 장벽이 되던 문제

문제: Exa 검색 API로 만들었더니, 앱을 처음 켜는 사람은 Exa 가입과 키 발급을
먼저 해야만 검색을 써볼 수 있었음. 포트폴리오를 보는 사람 입장에선 키 하나
때문에 "검색 결과가 없습니다" 에러만 보게 됨.

원인 분석: 검색과 생성이 Exa에 강하게 묶여 있었음. 검색을 담당하는 부분만
갈아끼울 수 있으면 되는데 구조가 그렇지 못했음.

해결: 검색 라우트에서 키 유무로 경로를 나눴음. Exa 키가 있으면 기존대로,
없으면 Gemini 내장 구글 검색으로 검색과 생성을 한 번에 처리함. 이미 갖고
있던 Gemini 키만으로 전체가 동작하게 됐고, 프론트는 이벤트 타입 기준으로
화면을 그리기 때문에 거의 손대지 않았음(delta에서 phase 전환 한 줄만 추가).

배운 것: 외부 의존성은 "없을 때의 경로"를 같이 설계해야 함. 이게 음성
폴백(ElevenLabs 실패 → 브라우저 음성)과도 같은 원칙이라, 앱 전체에 일관되게
적용했음.

### 2. 스트리밍 응답이 중간에서 잘려 파싱이 깨지던 문제

문제: 서버가 SSE로 흘려보낸 이벤트를 프론트에서 JSON.parse 할 때, 가끔
파싱이 터졌음. 재현이 잘 안 돼서 원인 찾기가 까다로웠음.

원인 분석: 네트워크는 내가 보낸 이벤트 단위로 데이터를 전달하지 않음.
`data: {"type":"del` 까지만 도착하고 나머지 `ta","text":"..."}` 는 다음
조각에 오는 식으로, 이벤트 경계와 무관하게 잘려서 도착함. 도착한 조각을
바로 파싱하니 반토막 JSON에서 에러가 난 것임.

해결: 받은 데이터를 버퍼에 쌓고, 이벤트 구분자인 빈 줄(\n\n)로만 자름.
자를 때 마지막 조각은 아직 미완성일 수 있으므로 파싱하지 않고 다음 턴을 위해
버퍼에 남김.

```ts
// web/src/api.ts — 핵심 부분
buffer += decoder.decode(value, { stream: true });
const parts = buffer.split("\n\n");  // 이벤트는 빈 줄로 구분
buffer = parts.pop() ?? "";          // 마지막 미완성 조각은 남겨둔다
for (const part of parts) {
  if (part.trim().startsWith("data:")) onEvent(JSON.parse(part.trim().slice(5)));
}
```

배운 것: 스트림은 메시지 단위가 아니라 바이트 단위로 옴. 경계를 직접
관리해야 한다는 걸 체감했음.

---

## 과부하·장애에 견디는 4계층 방어

느리고(5~7초) 가끔 실패하는 외부 AI를 감싸는 서버라, "많이 처리하기"보다 "외부가
흔들려도 버티기"를 핵심 문제로 봤음.

```
요청 → [1] Rate Limiter (IP별 Token Bucket, 직접 구현) ─초과─▶ 429 안전 거부
     → [2] Circuit Breaker (연속 실패 시 회로 열고 빠른 실패)
     → [3] Bulkhead (외부 API별 세마포어로 동시성 격리)
     → [4] Graceful Degradation (과부하 시 TTS부터 순서대로 포기)
     → 정상 처리 (+ LRU+TTL 캐시로 반복 질문 즉시 응답)
```

부하 테스트로 실측한 대표 수치:

- 답변 캐시: 반복 질문 부하에서 p50 3905ms → 1ms, 처리율 2.7배
- 서킷 브레이커: 실패율 50% 장애에서 벽시계 절반(16.5초 → 8.9초), p50 6배 단축
- Rate Limiter: 한 IP 폭주는 429로 차단, 같은 순간 다른 IP는 전부 통과

대시보드에서 "외부 AI 죽이기" 같은 장애를 주입하면 서킷이 열리고 그래프가 튀는 걸
실시간으로 볼 수 있음. 각 계층의 대안 비교(라이브러리/인프라 레벨)와 측정 방법론은
[RESILIENCE.md](RESILIENCE.md)에 정리했음. 장애 주입 엔드포인트는 배포 시
ADMIN_TOKEN으로 보호함.

---

## 지표

응답 속도 (실측, Gemini 내장 검색 경로, 5개 질문):

| 질문 | 응답 시간 |
|---|---|
| 2026년 최저시급 얼마야 | 5.0초 |
| 요즘 개봉한 영화 추천 | 5.9초 |
| 전기차 보조금 올해 어떻게 바뀌었어 | 7.0초 |
| 서울 오늘 날씨 | 4.6초 |
| 환율 지금 얼마야 | 4.3초 |

평균 약 5.3초 (검색 + LLM 생성 포함, 첫 글자까지는 더 빠름).

그 외 지표 (배포 후 채울 자리):
- 사용자 수:
- 일일 검색 수:
- 첫 글자까지 걸린 시간(TTFB):

---

## 핵심 로직 스니펫

전체 코드가 아니라 설계 의도가 드러나는 부분만 발췌.

### 검색 경로 선택 (지휘자)

server/src/routes/search.ts — 키 유무로 경로를 나누는 부분.

```ts
if (!process.env.EXA_API_KEY) {
  // Exa 키가 없으면 Gemini 내장 구글 검색으로 검색+생성을 한 번에
  for await (const event of streamGroundedAnswer(question)) {
    if (event.kind === "text") send({ type: "delta", text: event.text });
    else send({ type: "sources", sources: /* 참고 페이지 */ });
  }
  return res.end();
}

// Exa 키가 있으면 검색을 먼저 하고, 출처를 답변보다 먼저 보낸다
const results = await searchWeb(question);
send({ type: "sources", sources: /* 5건 */ });
for await (const text of streamAnswer(question, results)) {
  send({ type: "delta", text });
}
send({ type: "done", elapsedMs: Date.now() - started });
```

### 두 LLM SDK를 하나로 통일 (어댑터)

server/src/llm.ts — 모양이 다른 두 API를 같은 껍데기로 감싼 부분.

```ts
async function* streamGemini(prompt: string) {
  const stream = await ai.models.generateContentStream({ model, contents: prompt });
  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;            // Gemini는 chunk.text
  }
}

async function* streamOpenAI(prompt: string) {
  const stream = await openai.chat.completions.create({ model, messages, stream: true });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content; // OpenAI는 여기
    if (text) yield text;
  }
}

// 라우트는 어느 프로바이더인지 몰라도 된다
export function streamAnswer(question, sources) {
  const prompt = buildPrompt(question, sources);
  return process.env.LLM_PROVIDER === "openai" ? streamOpenAI(prompt) : streamGemini(prompt);
}
```

### 외부 호출 보호막: 네 겹을 한 번의 call()로

server/src/resilience/guard.ts — 모든 외부 API 호출(gemini, exa, elevenlabs)을
서킷 브레이커 → 재시도 → 세마포어 → 타임아웃 순서로 감쌈. 재시도는 "나을 병"
(429/5xx 같은 일시 오류)만 지수 백오프로 다시 시도하고, 401(키 오류) 같은 "안 나을
병"은 바로 던져 사용자에게 원인을 알림.

```ts
const RETRYABLE = new Set([429, 500, 502, 503, 504]); // 일시 오류만 재시도

call<T>(fn: () => Promise<T>): Promise<T> {
  return this.breaker.run(() =>            // 1) 서킷: 계속 죽는 API는 호출 없이 즉시 실패
    withRetry(                             // 2) 재시도: 일시 오류만 0.5s→1s→2s 백오프
      () => this.semaphore.run(            // 3) 세마포어: API별 동시 실행 상한(Bulkhead)
        () => withTimeout(fn(), this.opts.timeoutMs, this.opts.label) // 4) 타임아웃
      ),
      this.opts.label,
      this.retryDelays
    )
  );
}
```

겹의 순서에 이유가 있음. 백오프로 기다리는 동안에는 세마포어 슬롯을 잡고 있지 않고
(재시도가 세마포어 바깥), 죽은 API는 서킷이 가장 바깥에서 끊어 재시도조차 하지 않음.

### 음성 폴백

web/src/App.tsx — 서버 음성이 실패하면 브라우저 음성으로.

```ts
const blob = await requestVoice(answer);   // 실패 시 null
if (blob) {
  new Audio(URL.createObjectURL(blob)).play();      // ElevenLabs mp3
} else {
  const u = new SpeechSynthesisUtterance(answer);   // 브라우저 내장 음성
  u.lang = "ko-KR";
  speechSynthesis.speak(u);
}
```

---

## 기술 스택

- 프론트: React (Vite, TypeScript)
- 백엔드: Node.js + Express (TypeScript)
- 웹 검색: Gemini 내장 구글 검색(기본) 또는 Exa API
- LLM: Gemini `gemini-3.6-flash`(기본) 또는 OpenAI, 무료 티어로 동작
- 음성 입력: Web Speech API (브라우저 내장)
- 음성 출력: ElevenLabs TTS + speechSynthesis 폴백
- 회복탄력성: Rate Limiter / Circuit Breaker / Bulkhead / 캐시 직접 구현 (유닛 테스트 21개, node:test)
- 로깅·관측: pino 구조화 로그 + 인메모리 메트릭(p50/p95/p99) + 실시간 대시보드
- 부하 테스트: 자체 SSE 스크립트 + k6

## 한계와 다음 계획

- 음성 인식이 Web Speech API 의존이라 크롬 계열에서만 동작함. Whisper API로
  바꾸면 브라우저를 안 가리지만 녹음 업로드 구조가 필요함.
- 단발 질문만 지원(멀티턴 없음).
- 음성 재생이 답변 생성 완료 후 시작됨. ElevenLabs 스트리밍 API로 문장 단위로
  미리 만들면 첫 소리까지의 대기를 줄일 수 있음.
- 배포는 Render(서버) + Netlify(프론트) 무료 티어로 예정임.
