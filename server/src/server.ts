import "dotenv/config";
import express from "express";
import cors from "cors";
import searchRouter, { cacheStats } from "./routes/search.js";
import voiceRouter from "./routes/voice.js";
import { metrics } from "./metrics.js";
import { guardMetrics } from "./guards.js";
import { RateLimiter } from "./resilience/rateLimiter.js";
import { runtimeConfig, patchConfig } from "./runtimeConfig.js";
import { logger } from "./logger.js";

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

app.use("/api/search", (req, res, next) => {
  metrics.inc("ingress.total"); // rate limit 통과 전 총 유입
  if (runtimeConfig.rateLimitEnabled && !rateLimiter.allow(clientKey(req))) {
    // 503(서버 에러)이 아니라 429(요청 과다)로 준다. 서버는 멀쩡하고 "네가 너무 많이
    // 보냈다"는 뜻이라, 클라이언트가 백오프 후 재시도하면 되는 정상 신호다.
    metrics.inc("ingress.rateLimited");
    return res.status(429).json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." });
  }
  next();
});

app.use("/api/search", searchRouter);
app.use("/api/voice", voiceRouter);

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
  });
});

// 부하 테스트 회차 사이에 카운터를 깨끗이 비운다
app.post("/api/metrics/reset", (_req, res) => {
  metrics.reset();
  res.json({ ok: true });
});

// 장애/부하 주입: 대시보드가 실패율·지연·rate limit·저하 레벨을 런타임에 바꾼다.
// 데모에서 "외부 AI 죽이기", "rate limit 강화" 버튼이 이걸 호출한다.
app.get("/api/admin/config", (_req, res) => res.json(runtimeConfig));
app.post("/api/admin/config", (req, res) => {
  patchConfig(req.body || {});
  res.json({ ok: true, config: runtimeConfig });
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
