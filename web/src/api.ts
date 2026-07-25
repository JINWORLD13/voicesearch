export type Source = {
  index: number;
  title: string;
  url: string;
  domain: string;
  publishedDate: string | null;
};

export type SearchEvent =
  | { type: "sources"; sources: Source[] }
  | { type: "delta"; text: string }
  | { type: "done"; elapsedMs: number }
  | { type: "error"; message: string };

// SSE 응답을 읽어서 이벤트 단위로 콜백에 넘긴다.
// EventSource는 POST를 못 보내서 fetch로 직접 파싱한다.
export async function streamSearch(question: string, onEvent: (e: SearchEvent) => void) {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "요청에 실패했습니다.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 이벤트는 빈 줄(\n\n)로 구분된다. 마지막 조각은 아직 미완성일 수 있어 남겨둔다.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      onEvent(JSON.parse(line.slice(5)));
    }
  }
}

// ---- 대시보드용 (관측 + 장애 주입) ----

export type Metrics = {
  counters: Record<string, number>;
  latency: { count: number; p50: number; p95: number; p99: number; max: number };
  cache: { size: number; hits: number; misses: number; evictions: number; hitRate: number };
  guards: Record<string, { circuit: { state: string; failures: number; shortCircuited: number }; inUse: number; queued: number }>;
  rateLimiter: { trackedKeys: number; config: { enabled: boolean; capacity: number; refillPerSec: number } };
  degradation: string;
};

export type RuntimeConfig = {
  mockFailRate: number;
  mockMinMs: number;
  mockMaxMs: number;
  rateLimitEnabled: boolean;
  rateLimitCapacity: number;
  rateLimitRefillPerSec: number;
  degradation: string;
};

export async function fetchMetrics(): Promise<Metrics> {
  const res = await fetch("/api/metrics");
  if (!res.ok) throw new Error("메트릭을 불러오지 못했습니다.");
  return res.json();
}

export async function fetchConfig(): Promise<RuntimeConfig> {
  const res = await fetch("/api/admin/config");
  if (!res.ok) throw new Error("설정을 불러오지 못했습니다.");
  return res.json();
}

export async function injectConfig(patch: Partial<RuntimeConfig>): Promise<void> {
  await fetch("/api/admin/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function resetMetrics(): Promise<void> {
  await fetch("/api/metrics/reset", { method: "POST" }).catch(() => {});
}

// 부하 발사: 브라우저에서 동시에 여러 검색을 쏜다.
// sameUser=true면 한 IP(X-Forwarded-For 고정)로 몰아 rate limit 429를 유발하고,
// false면 가상 IP를 흩뿌려 처리량/서킷을 관찰한다. SSE 본문은 취소해 부하만 준다.
export async function fireLoad(count: number, sameUser: boolean): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const ip = sameUser ? "9.9.9.9" : `10.0.${Math.floor(i / 256) % 256}.${i % 256}`;
      return fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ question: `부하 질문 ${i % 20}` }),
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    })
  );
}

// 답변을 mp3로 받아온다. 서버에 ElevenLabs 키가 없거나 실패하면
// null을 돌려주고, 호출한 쪽에서 브라우저 내장 음성으로 폴백한다.
export async function requestVoice(text: string): Promise<Blob | null> {
  try {
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}
