import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import searchRouter, { cacheStats, resetCacheStats } from "./routes/search.js";
import voiceRouter from "./routes/voice.js";
import { metrics } from "./metrics.js";
import { guardMetrics, resetGuards } from "./guards.js";
import { RateLimiter } from "./resilience/rateLimiter.js";
import { runtimeConfig, patchConfig } from "./runtimeConfig.js";
import { logger } from "./logger.js";
import { eventLog } from "./eventLog.js";

const app = express();

// CORS: 프로덕션에선 지정한 프론트 도메인만 허용한다. FRONTEND_URL이 없으면(로컬 개발)
// 모든 origin을 반사해 편의를 준다. 전체 개방을 프로덕션까지 끌고 가지 않기 위함.
app.use(cors({ origin: process.env.FRONTEND_URL || true }));

// 본문 크기 상한. 검색 질문은 200자 남짓이라 16kb면 충분하고, 큰 페이로드로
// 메모리를 압박하는 요청을 앞단에서 막는다.
app.use(express.json({ limit: "16kb" }));

// 헬스체크: 로드밸런서나 Render 같은 배포 플랫폼이 "이 인스턴스가 살아있나"를
// 확인하는 엔드포인트. 없으면 죽은 인스턴스로 트래픽이 계속 흘러간다.
app.get("/api/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Rate Limiter: 방어의 최앞단. 사용자(IP)별 Token Bucket으로 폭주를 429로 거부한다.
// 키는 X-Forwarded-For(프록시 뒤 실제 IP) 우선, 없으면 소켓 IP. 부하 도구는
// 이 헤더로 가상 사용자 N명을 시뮬레이션한다.
const rateLimiter = new RateLimiter(
  () => runtimeConfig.rateLimitCapacity,
  () => runtimeConfig.rateLimitRefillPerSec
);

function clientKey(req: express.Request): string {
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  metrics.inc("ingress.total"); // rate limit 통과 전 총 유입
  if (runtimeConfig.rateLimitEnabled && !rateLimiter.allow(clientKey(req))) {
    // 503(서버 에러)이 아니라 429(요청 과다)로 준다. 서버는 멀쩡하고 "네가 너무 많이
    // 보냈다"는 뜻이라, 클라이언트가 백오프 후 재시도하면 되는 정상 신호다.
    metrics.inc("ingress.rateLimited");
    return res.status(429).json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." });
  }
  next();
}

// 검색과 음성 모두 같은 IP별 버킷을 쓴다. 음성을 빼면 반복 호출만으로
// ElevenLabs 월 무료 한도를 고갈시킬 수 있다(세마포어는 동시성만 막지 총량은 못 막는다).
app.use("/api/search", rateLimit, searchRouter);
app.use("/api/voice", rateLimit, voiceRouter);

// 장애 주입/메트릭 리셋은 포트폴리오 데모용 관리 기능이다. 방문자 누구나 대시보드에서
// 눌러볼 수 있게 의도적으로 열어둔다. ADMIN_TOKEN을 설정하면 그 값과 일치하는 헤더가
// 있을 때만 허용해 잠글 수 있고, 설정하지 않으면(기본값) 누구나 사용 가능하다.
// 주의: 인스턴스 하나가 상태(rate limit, degradation 등)를 전역으로 공유하므로, 열어두면
// 한 방문자의 조작이 그 시점의 다른 방문자에게도 그대로 영향을 준다. 데모 목적상
// 감수하되, 방치된 조작은 마지막 조작 10분 뒤 자동 정상화된다(runtimeConfig.ts).
function adminOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = process.env.ADMIN_TOKEN;
  if (token) {
    if (req.headers["x-admin-token"] === token) return next();
    return res.status(401).json({ error: "관리 토큰이 올바르지 않습니다." });
  }
  next();
}

// 관측 엔드포인트: 지연 백분위, 결과별 카운트, 캐시 적중률, 각 외부 API의
// 서킷/동시성 상태, rate limit 현황을 한눈에 준다. 대시보드/부하 스크립트가 여기서 읽는다.
app.get("/api/metrics", (_req, res) => {
  res.json({
    ...metrics.snapshot(),
    cache: cacheStats(),
    guards: guardMetrics(),
    rateLimiter: { trackedKeys: rateLimiter.trackedKeys, config: {
      enabled: runtimeConfig.rateLimitEnabled,
      capacity: runtimeConfig.rateLimitCapacity,
      refillPerSec: runtimeConfig.rateLimitRefillPerSec,
    } },
    degradation: runtimeConfig.degradation,
    // 대시보드가 "부하 주입" 버튼을 켤지 판단하는 값. MOCK_LLM이 없는 실배포에서
    // 부하 주입은 브라우저가 실제 /api/search로 진짜 요청을 쏘는 것이라, 진짜 Gemini
    // 무료 할당량을 태운다 — 이미 한 번 겪었다. mock일 때만 버튼을 켜지게 한다.
    mockEnabled: Boolean(process.env.MOCK_LLM),
  });
});

// 전체 초기화: 부하 테스트 회차 사이에 카운터를 비우는 용도로 시작했지만, 방문자가
// 부하 주입을 걸어놓고 안 돌아오는 상황(서킷 open, 세마포어 큐 적체, IP별 rate limit
// 소진)도 Render 재시작 없이 여기서 바로 풀 수 있도록 범위를 넓혔다.
app.post("/api/metrics/reset", adminOnly, (_req, res) => {
  metrics.reset();
  resetCacheStats();
  resetGuards();
  rateLimiter.reset();
  runtimeConfig.degradation = "none";
  eventLog.push("admin", "전체 초기화 실행(메트릭·캐시 통계·서킷·대기열·rate limiter)");
  res.json({ ok: true });
});

// 장애/부하 주입: 대시보드가 실패율·지연·rate limit·저하 레벨을 런타임에 바꾼다.
// 데모에서 "외부 AI 죽이기", "rate limit 강화" 버튼이 이걸 호출한다.
app.get("/api/admin/config", adminOnly, (_req, res) => res.json(runtimeConfig));
app.post("/api/admin/config", adminOnly, (req, res) => {
  patchConfig(req.body || {});
  eventLog.push("admin", `설정 변경: ${JSON.stringify(req.body || {})}`);
  res.json({ ok: true, config: runtimeConfig });
});

// 이벤트 로그: 서킷 열림/닫힘, 관리자 조작 같은 굵직한 사건을 대시보드가 보여준다.
// 메트릭처럼 관측용이라 관리 토큰 없이도 읽을 수 있게 열어둔다.
app.get("/api/events", (_req, res) => res.json(eventLog.list()));

// 프론트(web/dist)를 같은 서버가 서빙한다. Netlify 같은 별도 정적 호스팅 없이
// 배포 하나로 끝내기 위함 — 도메인이 하나라 CORS/리다이렉트 설정도 필요 없어진다.
// 로컬 개발은 vite dev 서버(5173)를 쓰므로 web/dist가 없어도 상관없다.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, "../../web/dist");
app.use(express.static(webDist));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) res.status(404).json({ error: "not found" });
  });
});

const PORT = Number(process.env.PORT || 3001);
const provider = process.env.LLM_PROVIDER || "gemini";

const server = app.listen(PORT, () => {
  console.log(`server: http://localhost:${PORT} (LLM: ${provider})`);

  // 켜자마자 뭐가 빠졌는지 보이게 시작 시점에 한 번 점검한다
  if (!process.env.EXA_API_KEY) {
    if (provider === "gemini") {
      console.log("EXA_API_KEY가 없어 Gemini 내장 구글 검색으로 동작합니다.");
    } else {
      console.warn("EXA_API_KEY가 비어 있습니다. openai 프로바이더는 검색이 동작하지 않습니다. (server/.env)");
    }
  }
  const llmKey = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
  if (!process.env[llmKey]) {
    console.warn(`${llmKey}가 비어 있습니다. 답변 생성이 동작하지 않습니다. (server/.env)`);
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("ELEVENLABS_API_KEY가 비어 있습니다. 음성 재생은 브라우저 내장 음성으로 폴백합니다.");
  }
});

// Graceful shutdown: 배포 재시작이나 스케일다운은 SIGTERM으로 온다. 새 연결은 그만
// 받되 진행 중인 요청은 마무리하고 종료해, 무중단 배포에서 요청이 끊기지 않게 한다.
// 10초 안에 안 끝나면 강제 종료(매달린 요청이 종료를 막지 않게).
function shutdown(signal: string) {
  logger.info({ event: "shutdown.begin", signal });
  server.close(() => {
    logger.info({ event: "shutdown.done" });
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn({ event: "shutdown.forced" });
    process.exit(1);
  }, 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// 최후의 안전망: 어디서도 못 잡은 예외/거부. 잡지 않으면 프로세스가 조용히 죽는다.
// 로그로 남겨 원인을 추적할 수 있게 한다. 엄밀히는 uncaughtException 후 프로세스
// 상태를 신뢰할 수 없어 종료 후 오케스트레이터가 재시작하는 게 정석이지만, 단일
// 데모 서버라 여기선 기록만 남기고 유지한다.
process.on("unhandledRejection", (reason) => {
  logger.error({ event: "unhandledRejection", reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error({ event: "uncaughtException", err: String(err) });
});
