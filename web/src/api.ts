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
      let event: SearchEvent;
      try {
        event = JSON.parse(line.slice(5));
      } catch {
        continue; // 깨진 조각 하나 때문에 뒤따르는 delta/done까지 잃지 않는다
      }
      onEvent(event);
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
  mockEnabled: boolean;
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

export type LogEvent = { ts: number; type: string; message: string };

export async function fetchEvents(): Promise<LogEvent[]> {
  const res = await fetch("/api/events");
  if (!res.ok) throw new Error("이벤트 로그를 불러오지 못했습니다.");
  return res.json();
}

// 장애 주입/리셋은 서버에서 ADMIN_TOKEN으로 보호된다(배포 환경).
// 대시보드에서 입력한 토큰을 저장해두고 관리 요청마다 헤더로 보낸다.
const ADMIN_TOKEN_KEY = "vs.adminToken";

export function saveAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

function adminHeaders(): Record<string, string> {
  const token = localStorage.getItem(ADMIN_TOKEN_KEY);
  return token ? { "x-admin-token": token } : {};
}

export async function fetchConfig(): Promise<RuntimeConfig> {
  const res = await fetch("/api/admin/config", { headers: adminHeaders() });
  if (!res.ok) {
    const err = new Error("설정을 불러오지 못했습니다.") as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 관리 요청은 상태 코드를 삼키면 안 된다. 서버가 ADMIN_TOKEN으로 잠가 401을 줘도
// 조용히 성공처럼 보이면, 대시보드는 "눌렀는데 아무 일도 안 일어난다"가 되고
// 초기화는 실제로 아무것도 안 지운 채 그래프만 비운다. 호출한 쪽이 판단하게 던진다.
function adminError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export async function injectConfig(patch: Partial<RuntimeConfig>): Promise<void> {
  const res = await fetch("/api/admin/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw adminError(res.status, "설정을 적용하지 못했습니다.");
}

// 메트릭뿐 아니라 서킷/세마포어 큐/rate limiter까지 서버 쪽 상태를 전부 초기화한다.
// 부하 주입 뒤 막혀버린 상태를 Render 재시작 없이 여기서 바로 풀 수 있다.
export async function resetAll(): Promise<void> {
  const res = await fetch("/api/metrics/reset", { method: "POST", headers: adminHeaders() });
  if (!res.ok) throw adminError(res.status, "초기화하지 못했습니다.");
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
export async function requestVoice(text: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal, // 사용자가 정지하거나 새 검색을 시작하면 이 요청은 버린다
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}
