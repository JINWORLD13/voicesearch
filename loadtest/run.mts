// 부하 스크립트. 서버에 동시 요청을 퍼부어 회복탄력성 계층이 실제로 버티는지 잰다.
//
// 왜 autocannon 같은 표준 툴을 안 쓰고 직접 짰나:
// 이 엔드포인트는 SSE 스트리밍이라, 요청 하나가 "연결 → 조각들 → done"까지 이어진다.
// 단순 HTTP 반복 측정기는 done까지 읽지 않아 "완료 시간"과 "cached 여부", "에러 종류"를
// 집계하지 못한다. 그래서 SSE를 끝까지 읽고 시나리오 지표를 뽑는 측정기를 직접 만들었다.
//
// 실행: npx tsx loadtest/run.mts [동시성] [총요청수]
//   예: npx tsx loadtest/run.mts 100 500
// 서버는 MOCK_LLM=1로 띄워야 실제 LLM 없이 서버 계층만 측정된다.

const BASE = process.env.LOADTEST_BASE || "http://localhost:3001";
const CONCURRENCY = Number(process.argv[2] || 100);
const TOTAL = Number(process.argv[3] || 500);

// 20종 질문을 랜덤 반복한다. 반복되는 질문은 캐시 히트를 유발해,
// 실제 서비스처럼 "인기 질문은 캐시에서, 새 질문은 외부로" 나뉘는 상황을 재현한다.
const QUESTIONS = Array.from({ length: 20 }, (_, i) => `부하 테스트 질문 번호 ${i}`);

type Outcome = "success" | "cached" | "error";
type Result = { ok: boolean; ms: number; outcome: Outcome };

// 요청 하나: SSE를 done(또는 error)까지 읽고 걸린 시간과 결과 종류를 돌려준다.
async function oneRequest(question: string): Promise<Result> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!res.ok || !res.body) return { ok: false, ms: Date.now() - started, outcome: "error" };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome: Outcome = "error";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === "done") outcome = ev.cached ? "cached" : "success";
        else if (ev.type === "error") outcome = "error";
      }
    }
    return { ok: outcome !== "error", ms: Date.now() - started, outcome };
  } catch {
    return { ok: false, ms: Date.now() - started, outcome: "error" };
  }
}

// 동시성을 CONCURRENCY로 유지하면서 TOTAL개를 처리한다(워커 풀 패턴).
async function run() {
  console.log(`부하 시작: 동시성=${CONCURRENCY}, 총요청=${TOTAL}, 대상=${BASE}`);
  await fetch(`${BASE}/api/metrics/reset`, { method: "POST" }).catch(() => {});

  const results: Result[] = [];
  let dispatched = 0;
  const wallStart = Date.now();

  async function worker() {
    while (dispatched < TOTAL) {
      const idx = dispatched++;
      const q = QUESTIONS[idx % QUESTIONS.length];
      results.push(await oneRequest(q));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const wallMs = Date.now() - wallStart;
  report(results, wallMs);

  // 서버가 스스로 집계한 지표도 같이 찍는다(클라 측정과 교차 검증)
  const serverMetrics = await fetch(`${BASE}/api/metrics`).then((r) => r.json());
  console.log("\n=== 서버 측 메트릭 ===");
  console.log(JSON.stringify(serverMetrics, null, 2));
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(results: Result[], wallMs: number) {
  const byOutcome = { success: 0, cached: 0, error: 0 };
  for (const r of results) byOutcome[r.outcome]++;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const okCount = byOutcome.success + byOutcome.cached;

  console.log("\n=== 클라이언트 측 결과 ===");
  console.log(`총 ${results.length}건, 벽시계 ${(wallMs / 1000).toFixed(1)}초, 처리율 ${(results.length / (wallMs / 1000)).toFixed(1)} req/s`);
  console.log(`성공률 ${((okCount / results.length) * 100).toFixed(1)}%  (성공 ${byOutcome.success}, 캐시 ${byOutcome.cached}, 에러 ${byOutcome.error})`);
  console.log(`지연  p50=${pct(latencies, 50)}ms  p95=${pct(latencies, 95)}ms  p99=${pct(latencies, 99)}ms  max=${latencies[latencies.length - 1]}ms`);
}

run();
