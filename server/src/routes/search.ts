import { Router } from "express";
import { randomUUID } from "node:crypto";
import { searchWeb } from "../exa.js";
import { streamAnswer, streamGroundedAnswer } from "../llm.js";
import { LruTtlCache, CircuitOpenError, TimeoutError, statusOf } from "../resilience/index.js";
import { metrics } from "../metrics.js";
import { requestLogger } from "../logger.js";
import { runtimeConfig } from "../runtimeConfig.js";

const router = Router();

const MAX_QUESTION_LENGTH = 200;

type SourcePayload = {
  index: number;
  title: string;
  url: string;
  domain: string;
  publishedDate: string | null;
};
type CachedAnswer = { answer: string; sources: SourcePayload[]; path: string };

// 같은 질문이 다시 오면 LLM을 부르지 않고 즉시 답한다.
// 500개까지, 10분 동안 유지. 웹 검색 결과는 시간이 지나면 낡으므로 TTL을 짧게 둔다.
const answerCache = new LruTtlCache<CachedAnswer>(500, 10 * 60 * 1000);

// 메트릭 엔드포인트에서 캐시 적중률을 보여주려고 노출한다
export function cacheStats() {
  return answerCache.stats;
}

// 캐시 적중률을 높이려고 키를 정규화한다.
// "2026년 최저시급  얼마야?" 와 "2026년 최저시급 얼마야?"를 같은 질문으로 본다.
function cacheKey(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

// 캐시된 답변도 실제 생성과 같은 이벤트 순서(sources → delta 여러 개 → done)로 보낸다.
// 지연 없이 연달아 쓰므로 시각적으로는 거의 한 번에 도착하지만, 프론트가 캐시 히트를
// 특별 취급하지 않고 같은 렌더 경로를 타게 하는 게 목적이다.
function* replayChunks(answer: string): Generator<string> {
  const words = answer.split(" ");
  for (let i = 0; i < words.length; i += 6) {
    yield words.slice(i, i + 6).join(" ") + (i + 6 < words.length ? " " : "");
  }
}

router.post("/", async (req, res) => {
  const reqId = randomUUID().slice(0, 8);
  const log = requestLogger(reqId);
  const started = Date.now();
  metrics.inc("requests.total");

  const question = (req.body?.question || "").trim();
  if (!question) {
    metrics.inc("requests.badRequest");
    return res.status(400).json({ error: "검색어를 입력해주세요." });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    metrics.inc("requests.badRequest");
    return res.status(400).json({ error: `검색어는 ${MAX_QUESTION_LENGTH}자 이하로 입력해주세요.` });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // 클라이언트가 응답 도중 연결을 끊으면(탭 닫기 등) 알림을 받는다.
  // 이후로는 죽은 소켓에 쓰지 않고, 스트림 소비도 멈춰 자원을 회수한다.
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  const send = (data: unknown) => {
    if (!clientGone) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 1) 캐시 조회. 히트면 외부 호출 없이 즉시 응답한다(5~7초 → 수 ms).
  // DISABLE_CACHE=1은 부하 실험용 토글(before/after 비교). 프로덕션엔 설정하지 않는다.
  const cacheOn = !process.env.DISABLE_CACHE;
  const key = cacheKey(question);
  const cached = cacheOn ? answerCache.get(key) : undefined;
  if (cached) {
    metrics.inc("requests.cacheHit");
    send({ type: "sources", sources: cached.sources });
    for (const piece of replayChunks(cached.answer)) send({ type: "delta", text: piece });
    const elapsed = Date.now() - started;
    send({ type: "done", elapsedMs: elapsed, cached: true });
    metrics.recordLatency(elapsed);
    log.info({ event: "search.cacheHit", latencyMs: elapsed });
    return res.end();
  }
  metrics.inc("requests.cacheMiss");

  // Graceful Degradation: 과부하가 심할 때는 "다 살리기"가 아니라 우선순위 낮은 것부터
  // 포기해 핵심(캐시된 답)을 지킨다. 캐시 히트는 위에서 이미 처리됐고, 여기는 미스 경로다.
  //   reject     : 새 검색을 잠시 거부(외부 자원 보호). 가장 강한 저하.
  //   cache-only : 캐시에 있는 질문만 답하고, 새 외부 호출은 막는다.
  if (runtimeConfig.degradation === "reject") {
    metrics.inc("degradation.rejected");
    send({ type: "error", message: "지금 요청이 많아 검색을 잠시 제한하고 있어요. 잠시 후 다시 시도해주세요." });
    return res.end();
  }
  if (runtimeConfig.degradation === "cache-only") {
    metrics.inc("degradation.cacheOnly");
    send({ type: "error", message: "지금은 이미 검색된 질문만 답할 수 있어요. 잠시 후 다시 시도해주세요." });
    return res.end();
  }

  try {
    let answer = "";
    let sourcesPayload: SourcePayload[] = [];
    let path: string;

    // 2) 검색 경로 선택: Exa 키가 없으면 Gemini 내장 검색(폴백 경로)
    if (!process.env.EXA_API_KEY) {
      if ((process.env.LLM_PROVIDER || "gemini") !== "gemini") {
        metrics.inc("requests.error");
        send({ type: "error", message: "LLM_PROVIDER=openai로 쓸 때는 EXA_API_KEY가 필요합니다." });
        return res.end();
      }
      path = "grounded";
      metrics.inc("path.grounded");

      for await (const event of streamGroundedAnswer(question)) {
        if (clientGone) break; // 사용자가 떠났으면 생성을 계속 소비하지 않는다
        if (event.kind === "text") {
          answer += event.text;
          send({ type: "delta", text: event.text });
        } else if (event.sources.length > 0) {
          sourcesPayload = event.sources.map((s, i) => ({
            index: i + 1,
            title: s.title,
            url: s.url,
            domain: s.title,
            publishedDate: null,
          }));
          send({ type: "sources", sources: sourcesPayload });
        }
      }
    } else {
      path = "exa";
      metrics.inc("path.exa");

      const results = await searchWeb(question);
      if (results.length === 0) {
        metrics.inc("requests.empty");
        send({ type: "error", message: "검색 결과가 없습니다. 질문을 바꿔서 다시 시도해주세요." });
        return res.end();
      }
      sourcesPayload = results.map((r, i) => ({
        index: i + 1,
        title: r.title,
        url: r.url,
        domain: new URL(r.url).hostname.replace(/^www\./, ""),
        publishedDate: r.publishedDate?.slice(0, 10) ?? null,
      }));
      send({ type: "sources", sources: sourcesPayload });

      for await (const text of streamAnswer(question, results)) {
        if (clientGone) break; // 사용자가 떠났으면 생성을 계속 소비하지 않는다
        answer += text;
        send({ type: "delta", text });
      }
    }

    const elapsed = Date.now() - started;
    send({ type: "done", elapsedMs: elapsed });
    metrics.recordLatency(elapsed);
    metrics.inc("requests.success");

    // 3) 성공한 답변만 캐시에 넣는다. 빈 답변이나, 연결이 끊겨 중간에 멈춘
    //    부분 답변은 넣지 않는다(잘린 답이 캐시에 남아 다음 사용자에게 나가면 안 됨).
    if (cacheOn && answer.trim() && !clientGone) {
      answerCache.set(key, { answer, sources: sourcesPayload, path });
    }
    log.info({ event: "search.done", path, latencyMs: elapsed, answerLen: answer.length });
    res.end();
  } catch (e) {
    metrics.inc("requests.error");
    const elapsed = Date.now() - started;
    const { message, kind } = classifyError(e);
    metrics.inc(`error.${kind}`);
    log.error({ event: "search.error", kind, latencyMs: elapsed, err: String(e) });
    send({ type: "error", message });
    res.end();
  }
});

// 에러의 원인에 따라 사용자 메시지와 메트릭 분류를 나눈다.
// 원인마다 사용자가 취할 행동이 다르므로 뭉뚱그리지 않는다.
function classifyError(e: unknown): { message: string; kind: string } {
  if (e instanceof CircuitOpenError) {
    // 외부 API가 연속 실패해 회로가 열렸다 → 지금 몰렸으니 잠시 후
    return { message: "지금 요청이 많아요. 잠시 후 다시 시도해주세요.", kind: "circuit_open" };
  }
  if (e instanceof TimeoutError) {
    return { message: "응답이 지연되고 있어요. 잠시 후 다시 시도해주세요.", kind: "timeout" };
  }
  const status = statusOf(e);
  if (status === 401 || status === 403) {
    return { message: "API 키가 올바르지 않습니다. server/.env를 확인해주세요.", kind: "auth" };
  }
  return { message: "답변 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", kind: "unknown" };
}

export default router;
