**한국어** | [日本語](README.ja.md)

# VoiceSearch

**라이브 데모**: https://voicesearch-cwh9.onrender.com (Render 무료 티어라 첫 요청은 느릴 수 있음)

마이크에 대고 물어보면 웹을 검색해서 근거와 함께 답하고, 그 답을 음성으로
읽어주는 검색 서비스임. React, Express(TypeScript), Gemini API로 만들었고,
검색은 Exa API 또는 Gemini 내장 구글 검색, 음성 합성은 ElevenLabs 또는
브라우저 내장 음성을 씀.

![검색 화면 — 질문하면 출처 목록이 먼저 뜨고, 답변이 스트리밍된 뒤 음성으로 읽어준다](docs/screenshots/search.png)

## 왜 만들었나

LLM은 학습 시점 이후의 일을 모름. 앞서 문서 업로드 기반 RAG 챗봇(DocChat)을
만들면서 "근거를 주고, 근거 안에서만 답하게 하는" 구조를 연습했는데, 이번에는
그 근거를 업로드된 문서가 아니라 실시간 웹 검색에서 가져오도록 바꿔봤음.
여기에 입력은 음성 인식으로, 출력은 음성 합성으로 붙여서 화면을 계속 보지
않아도 쓸 수 있는 검색을 목표로 삼았음.

## 동작 방식

```
마이크 버튼 → 브라우저 Web Speech API가 말을 텍스트로 변환 (중간 결과 실시간 표시)
  → 말이 끝나면 자동으로 POST /api/search
  → EXA_API_KEY가 있으면
      Exa로 웹 검색 5건 → 출처 목록을 먼저 전송
      → 검색 결과를 프롬프트에 넣고 생성 → SSE로 토큰 단위 스트리밍
  → 없으면
      Gemini 내장 구글 검색(grounding)으로 검색과 생성을 한 번에
      → 답변 스트리밍 → 참고한 페이지를 출처로 전송

읽어주기 버튼 → POST /api/voice → ElevenLabs가 mp3 생성 → 재생
  → 키가 없거나 실패하면 브라우저 내장 음성(speechSynthesis)으로 폴백
```

## 신경 쓴 부분

### 음성으로 읽을 답변은 프롬프트부터 다르다

답변이 화면에도 보이지만 결국 소리로 읽힘. 그래서 프롬프트에서 마크다운
서식을 금지하고, 소리 내어 읽었을 때 자연스러운 문장을 요구했음. 실제로
"2.9%" 대신 "2.9퍼센트"처럼 풀어 쓴 답이 나옴. 출처 번호 [1]은 화면에는
필요하지만 낭독하면 어색해서, TTS로 보내기 전에 서버에서 제거함.

### 키가 없으면 있는 걸로 동작하게

외부 키가 준비 안 됐다고 데모가 죽는 게 싫어서, 유료·외부 API마다 대체
경로를 뒀음. 검색은 Exa 키가 없으면 Gemini 내장 구글 검색으로, 음성 합성은
ElevenLabs가 실패하면(키 없음, 한도 초과 모두) 브라우저 내장 speechSynthesis로
대신함. 그래서 GEMINI_API_KEY 하나만 있어도 전체 기능이 돌아감. 어느 음성으로
재생 중인지는 화면에 표시하고, ElevenLabs 무료 플랜(월 1만 자)을 아끼려고
TTS에 보내는 텍스트도 600자에서 자름.

### 출처를 답변보다 먼저 보낸다

Exa 경로에서는 검색이 끝나면 출처 5건(제목, 도메인, 날짜)을 먼저 내려보내고
그 다음 생성을 시작함. 생성을 기다리는 동안에도 뭘 근거로 답할지가 먼저 보여서
체감 대기가 짧음. 답변 문장 끝에는 [1], [2]로 어느 출처를 썼는지 표시하고,
출처끼리 내용이 다르면 더 최근 날짜를 우선하도록 했음. 내장 검색 경로는 검색과
생성이 한 호출이라 순서가 반대인데(답변 스트리밍 후 출처 도착), 프론트는 이벤트
타입만 보고 그리기 때문에 양쪽 순서를 모두 처리함.

### LLM 프로바이더 갈아끼우기

Gemini와 OpenAI를 .env의 LLM_PROVIDER 값 하나로 바꿀 수 있음. 두 SDK의
스트리밍 API 모양이 달라서, 둘 다 "텍스트 조각을 내보내는 async generator"로
감싸 통일했음. 라우트 쪽 코드는 어느 프로바이더가 붙어 있는지 모름.
429, 5xx 같은 일시 오류는 지수 백오프로 재시도하고, 키가 잘못된 401 같은
오류는 재시도 없이 바로 사용자에게 원인을 알림.

### 말이 끝나면 바로 검색

음성 인식 중간 결과(interim)를 계속 받아 입력창에 실시간으로 보여주다가,
브라우저가 발화 종료로 판단하면 확정 텍스트로 즉시 검색을 실행함. 버튼을
다시 누를 필요가 없음. Web Speech API가 크롬 계열에만 있어서, 미지원
브라우저에서는 마이크 버튼을 숨기고 텍스트 검색만 남김.

### 과부하와 장애에 견디는 4계층 방어

느리고 불안정한 외부 AI를 감싸는 서버라, "많이 처리하기"보다 "외부가 흔들려도
버티기"가 핵심이라고 봤음. Rate Limiter(Token Bucket 직접 구현) → Circuit
Breaker → Bulkhead(API별 세마포어) → Graceful Degradation의 4계층에 캐시·재시도·
타임아웃을 더했음. 각 결정의 대안 비교와 부하 테스트 실측(캐시 p50 3905→1ms,
장애 시 서킷이 벽시계 절반 단축 등)은 [docs/RESILIENCE.md](docs/RESILIENCE.md)에
정리했음. 대시보드에서 장애를 주입하며 방어가 발동하는 걸 실시간으로 볼 수 있고,
주입된 설정은 마지막 조작 10분 뒤 자동으로 정상화됨(방문자가 걸어두고 떠나도
데모가 오염된 채 남지 않게).

!["외부 AI 죽이기"를 누른 뒤의 대시보드 — 서킷이 열리고(차단 80), 429와 중단이 집계되고, 이벤트 로그에 서킷 open이 남는다](docs/screenshots/dashboard.png)

## 기술 스택

- 프론트: React (Vite, TypeScript)
- 백엔드: Node.js + Express (TypeScript)
- 웹 검색: Gemini 내장 구글 검색(기본) 또는 Exa API
- LLM: Gemini API `gemini-3.6-flash` (기본) 또는 OpenAI, 무료 티어로 동작
- 음성 입력: Web Speech API (브라우저 내장)
- 음성 출력: ElevenLabs TTS + speechSynthesis 폴백
- 로깅: pino (구조화 JSON 로그)
- 부하 테스트: 자체 스크립트 + k6

## 실행 방법

1. 서버

```bash
cd server
cp .env.example .env   # GEMINI_API_KEY만 넣으면 동작 (Exa, ElevenLabs는 선택)
npm install
npm run dev            # http://localhost:3001
```

2. 프론트

```bash
cd web
npm install
npm run dev            # http://localhost:5173
```

크롬에서 열고 마이크 버튼을 눌러 "2026년 최저시급 얼마야?"처럼 물어보면 됨.
ELEVENLABS_API_KEY는 없어도 동작함(브라우저 음성으로 폴백).

3. 테스트 (회복탄력성 유틸 26개 — 4계층 조합 guard 테스트 포함)

```bash
cd server && npm test
```

4. 부하 테스트 / 대시보드 데모 (외부 LLM 없이 서버 계층만 측정)

```bash
# 데모 서버: 외부 LLM을 느리고 가끔 실패하는 mock으로 격리
cd server && MOCK_LLM=1 MOCK_LLM_MIN_MS=300 MOCK_LLM_MAX_MS=1000 npm start
# 다른 터미널에서 부하 (동시 50, 총 200)
npx tsx loadtest/run.mts 50 200
# 프론트를 띄우고 대시보드 탭에서 장애/부하를 주입하며 관찰
```

## 프로젝트 구조

```
server/
  src/
    server.ts        Express 앱, Rate Limiter(검색·음성), 메트릭/주입 엔드포인트(ADMIN_TOKEN 보호)
    exa.ts           Exa 웹 검색 (exaGuard로 감쌈)
    llm.ts           Gemini/OpenAI 스트리밍 생성, 내장 검색(grounding) 경로
    guards.ts        외부 API별 보호막(서킷+재시도+세마포어+타임아웃) 설정
    runtimeConfig.ts 런타임 장애 주입 설정 (대시보드가 조정)
    mockLlm.ts       부하 테스트용 가짜 LLM (느리고 확률적 실패)
    logger.ts        pino 구조화 로깅
    metrics.ts       인메모리 메트릭 (p50/p95/p99, 카운터)
    sse.ts           SSE 파싱 순수 함수 (+ 테스트)
    resilience/
      timeout.ts, semaphore.ts, cache.ts, circuitBreaker.ts,
      rateLimiter.ts, guard.ts   (각 .test.ts 포함)
    routes/
      search.ts      Rate Limit → 캐시 → 경로 선택 → SSE, 로깅/메트릭/저하
      voice.ts       ElevenLabs TTS 프록시 (저하 시 포기)
web/
  src/
    api.ts           fetch + SSE 파싱, 메트릭/주입/부하 발사
    App.tsx          음성 인식, 검색 화면, 재생과 폴백, 탭 전환
    Dashboard.tsx    실시간 메트릭 그래프 + 장애/부하 주입 컨트롤
loadtest/
  run.mts            자체 부하 스크립트 (SSE done까지 읽어 시나리오 집계)
  k6-throughput.js   k6: 단계적 부하 증가, 429 안전 거부 검증
  k6-ratelimit.js    k6: 한 사용자 폭주 → Rate Limiter 차단율
docs/
  RESILIENCE.md      4계층 방어의 PAR (문제-대안비교-구현-실측)
  PORTFOLIO.md       아키텍처와 기술 선택 개요
  *.ja.md            위 문서의 일본어판 (README.ja.md 포함)
```

## 한계와 다음에 해볼 것

- 음성 인식이 Web Speech API 의존이라 크롬 계열에서만 됨. Whisper 같은
  STT API로 바꾸면 브라우저를 안 가리지만, 녹음을 서버로 올리는 구조가
  필요해서 다음 과제로 남겼음.
- 단발 질문만 됨. 이전 질문을 기억하는 멀티턴은 없음.
- 음성 재생이 답변 생성이 끝난 뒤에 시작됨. ElevenLabs 스트리밍 API로
  문장 단위로 미리 만들면 첫 소리까지의 대기를 줄일 수 있을 듯함.
- 내장 검색 경로는 출처 링크가 구글 리다이렉트 주소로 오고, 검색 결과의
  개수나 본문 발췌를 제어할 수 없고, 답변 속 [1] 인라인 번호도 못 붙임.
  이런 세밀한 제어가 필요하면 Exa 경로를 쓰면 됨.
- 배포는 Render 무료 티어로 완료함(Express가 리액트 빌드 결과물을 같이 서빙).
