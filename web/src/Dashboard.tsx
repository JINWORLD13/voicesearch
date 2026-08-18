import { useEffect, useRef, useState } from "react";
import {
  fetchMetrics,
  fetchConfig,
  fetchEvents,
  injectConfig,
  resetAll,
  fireLoad,
  saveAdminToken,
  type Metrics,
  type RuntimeConfig,
  type LogEvent,
} from "./api";
import "./Dashboard.css";

type Point = { p50: number; p95: number; rate: number };

// 이벤트 로그로 유지할 최대 개수(서버 eventLog는 100개를 들고 있다)
const MAX_EVENTS = 200;

// 최근 60초 시계열을 그리는 간단한 SVG 라인차트(외부 차트 라이브러리 없이).
function LineChart({ points, pick, color, unit }: { points: Point[]; pick: (p: Point) => number; color: string; unit: string }) {
  const w = 560;
  const h = 120;
  const values = points.map(pick);
  const maxV = Math.max(1, ...values);
  const n = points.length;
  const coords = points
    .map((p, i) => {
      const x = n <= 1 ? 0 : (i / (n - 1)) * w;
      const y = h - (pick(p) / maxV) * (h - 10) - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = values[values.length - 1] ?? 0;
  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-max">최대 {Math.round(maxV)}{unit}</span>
        <span className="chart-now" style={{ color }}>지금 {Math.round(last)}{unit}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="chart-svg">
        <polyline points={coords} fill="none" stroke={color} strokeWidth="2" />
      </svg>
    </div>
  );
}

function circuitColor(state: string): string {
  if (state === "open") return "#dc2626";
  if (state === "half-open") return "#d97706";
  return "#16a34a";
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [series, setSeries] = useState<Point[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // 배포 환경에선 관리 기능(주입/리셋)이 ADMIN_TOKEN으로 잠겨 있다.
  // 401/403이 오면 토큰 입력창을 보여주고, 맞는 토큰을 저장하면 다시 열린다.
  const [needToken, setNeedToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  // 슬라이더를 드래그하는 동안의 값은 로컬에만 둔다. 서버 값을 그대로 value로 쓰면
  // onChange마다 POST가 나가고(마우스 이동 속도 = 초당 수십 건), 그때마다 React가
  // 아직 낡은 서버 값으로 썸을 되돌려 커서 아래에서 손잡이가 튄다. 게다가 그 수십 건이
  // 전부 admin 이벤트로 남아 이벤트 로그가 슬라이더 기록으로 뒤덮인다.
  // 그래서 드래그 중엔 화면만 움직이고, 손을 뗄 때 한 번만 보낸다.
  const [capDraft, setCapDraft] = useState<number | null>(null);
  const [refillDraft, setRefillDraft] = useState<number | null>(null);
  const prevRef = useRef<{ total: number; t: number } | null>(null);
  // 이벤트 로그는 서버가 과거 기록도 들고 있지만, 대시보드는 새로고침 시점부터의
  // 사건만 보여준다(과거 기록을 다시 불러오지 않음) — 새로고침하면 화면이 깨끗해진다.
  const sessionStartRef = useRef<number>(Date.now());
  const seenEventsRef = useRef<Map<string, LogEvent>>(new Map());

  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => alive && setConfig(c))
      .catch((e: Error & { status?: number }) => {
        if (alive && (e.status === 401 || e.status === 403)) setNeedToken(true);
      });

    const tick = async () => {
      try {
        const m = await fetchMetrics();
        if (!alive) return;
        setMetrics(m);
        const total = m.counters["ingress.total"] ?? m.counters["requests.total"] ?? 0;
        const now = Date.now();
        let rate = 0;
        if (prevRef.current) {
          const dt = (now - prevRef.current.t) / 1000;
          rate = dt > 0 ? Math.max(0, (total - prevRef.current.total) / dt) : 0;
        }
        prevRef.current = { total, t: now };
        setSeries((s) => [...s.slice(-59), { p50: m.latency.p50, p95: m.latency.p95, rate }]);
      } catch {
        /* 서버 재시작 중 등은 조용히 넘긴다 */
      }
    };
    const id = setInterval(tick, 1000);
    tick();

    // 이벤트 로그는 자주 안 바뀌니 메트릭보다 느슨하게 돈다.
    // 서버는 과거 기록도 갖고 있지만, 여기선 이 페이지가 열린 시점(sessionStartRef)
    // 이후의 사건만 골라 누적한다 — 그래야 새로고침할 때마다 깨끗하게 시작한다.
    const tickEvents = async () => {
      try {
        const e = await fetchEvents();
        if (!alive) return;
        let changed = false;
        for (const ev of e) {
          if (ev.ts < sessionStartRef.current) continue;
          const key = `${ev.ts}:${ev.message}`;
          if (!seenEventsRef.current.has(key)) {
            seenEventsRef.current.set(key, ev);
            changed = true;
          }
        }
        if (changed) {
          const sorted = Array.from(seenEventsRef.current.values()).sort((a, b) => a.ts - b.ts);
          // 대시보드 탭은 숨김 처리라 언마운트되지 않는다(App.tsx). 오래 열어두면 맵이
          // 끝없이 자라므로 최근 것만 남긴다. 서버 eventLog가 100개만 들고 있어서,
          // 200개를 남기면 잘라낸 항목이 다시 "새 이벤트"로 들어올 일은 없다.
          const kept = sorted.slice(-MAX_EVENTS);
          seenEventsRef.current = new Map(kept.map((ev) => [`${ev.ts}:${ev.message}`, ev]));
          setEvents(kept);
        }
      } catch {
        /* 서버 재시작 중 등은 조용히 넘긴다 */
      }
    };
    const eventsId = setInterval(tickEvents, 3000);
    tickEvents();

    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(eventsId);
    };
  }, []);

  // 관리 요청이 401로 막히면 조용히 넘기지 않는다 — 버튼을 눌렀는데 아무 일도 일어나지
  // 않는 것처럼 보이는 게 제일 나쁘다. 토큰 입력창을 띄워 원인을 알려준다.
  function isAuthError(e: unknown): boolean {
    const status = (e as { status?: number })?.status;
    return status === 401 || status === 403;
  }

  async function inject(patch: Partial<RuntimeConfig>) {
    try {
      await injectConfig(patch);
    } catch (e) {
      if (isAuthError(e)) setNeedToken(true);
      return;
    }
    // 새 설정을 받아올 때까지 기다린다. 기다리지 않으면 슬라이더 초안을 지우는 쪽이
    // 먼저 돌아, 아직 낡은 서버 값으로 썸이 한 번 되돌아갔다 다시 튀는 게 보인다.
    try {
      setConfig(await fetchConfig());
    } catch {
      /* 다음 폴링에서 채워진다 */
    }
  }

  // 손을 뗀 순간 한 번만 서버에 보낸다. inject()가 새 설정을 다시 받아온 뒤에야
  // 로컬 초안을 지워, 낡은 값으로 썸이 잠깐 되돌아가는 깜빡임을 없앤다.
  async function commit(
    key: "rateLimitCapacity" | "rateLimitRefillPerSec",
    draft: number | null,
    clear: (v: number | null) => void
  ) {
    if (draft === null) return;
    await inject({ [key]: draft });
    clear(null);
  }

  async function withBusy(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const c = metrics?.counters ?? {};
  const ingress = c["ingress.total"] ?? 0;
  const rateLimited = c["ingress.rateLimited"] ?? 0;
  const success = c["requests.success"] ?? 0;
  const cacheHit = c["requests.cacheHit"] ?? 0;
  const errors = c["requests.error"] ?? 0;
  // 부하 주입은 응답을 기다리지 않고 본문을 끊는 가짜 클라이언트라 "중단"으로
  // 집계된다(성공도 실패도 아님). 숨기면 "유입은 많은데 처리가 0"으로 보여서 명시한다.
  const aborted = c["requests.aborted"] ?? 0;
  const served = success + cacheHit;
  const total = served + errors;

  return (
    <div className="dash">
      <p className="dash-note">
        방어 계층이 부하와 장애에 어떻게 반응하는지 실시간으로 봅니다. 아래 버튼으로 장애를
        주입하면(외부 AI 죽이기 등) 서킷이 열리고 그래프가 튀는 걸 관찰할 수 있어요.
        장애 주입은 데모 모드(MOCK_LLM)에서 동작합니다.
      </p>

      {/* 상태 카드 */}
      <div className="cards">
        <Card label="총 유입" value={String(ingress)} sub={`처리 ${served} · 중단 ${aborted} · 429 ${rateLimited}`} />
        <Card
          label="성공률"
          value={total ? `${Math.round((served / total) * 100)}%` : "-"}
          sub={`에러 ${errors}`}
          tone={total && served / total < 0.9 ? "bad" : "ok"}
        />
        <Card
          label="캐시 히트율"
          value={metrics ? `${Math.round(metrics.cache.hitRate * 100)}%` : "-"}
          sub={`히트 ${metrics?.cache.hits ?? 0}`}
        />
        <Card label="지연 p95" value={`${metrics?.latency.p95 ?? 0}ms`} sub={`p50 ${metrics?.latency.p50 ?? 0}ms`} />
        <Card
          label="Gemini 서킷"
          value={metrics?.guards.gemini.circuit.state ?? "-"}
          sub={`차단 ${metrics?.guards.gemini.circuit.shortCircuited ?? 0}`}
          color={metrics ? circuitColor(metrics.guards.gemini.circuit.state) : undefined}
        />
        <Card
          label="동시 실행(Bulkhead)"
          value={`${metrics?.guards.gemini.inUse ?? 0}`}
          sub={`대기 ${metrics?.guards.gemini.queued ?? 0}`}
        />
      </div>

      {/* 그래프 */}
      <div className="charts">
        <div>
          <h3>초당 요청</h3>
          <LineChart points={series} pick={(p) => p.rate} color="#2563eb" unit="/s" />
        </div>
        <div>
          <h3>지연 p95</h3>
          <LineChart points={series} pick={(p) => p.p95} color="#dc2626" unit="ms" />
        </div>
      </div>

      {/* 관리 토큰: 서버가 주입/리셋을 잠갔을 때만 보인다 */}
      {needToken && (
        <form
          className="control-group token-form"
          onSubmit={async (e) => {
            e.preventDefault();
            saveAdminToken(tokenInput.trim());
            try {
              setConfig(await fetchConfig());
              setNeedToken(false);
            } catch {
              /* 토큰이 틀리면 입력창을 유지한다 */
            }
          }}
        >
          <h3>관리 토큰</h3>
          <p className="dash-note">장애 주입과 메트릭 초기화는 서버의 ADMIN_TOKEN으로 보호돼 있어요.</p>
          <div className="btn-row">
            <input
              className="token-input"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="ADMIN_TOKEN 입력"
            />
            <button className="ctl" type="submit">확인</button>
          </div>
        </form>
      )}

      {/* 주입 컨트롤 */}
      <div className="controls">
        <div className="control-group">
          <h3>시나리오</h3>
          <div className="btn-row">
            <button className="ctl ok" onClick={() => inject({ mockFailRate: 0, mockMinMs: 2000, mockMaxMs: 6000, degradation: "none", rateLimitEnabled: true })}>
              정상화
            </button>
            <button className="ctl bad" onClick={() => inject({ mockFailRate: 1 })}>
              외부 AI 죽이기 (실패율 100%)
            </button>
            <button className="ctl warn" onClick={() => inject({ mockMinMs: 8000, mockMaxMs: 15000 })}>
              느린 응답 (8~15초)
            </button>
            <button className="ctl" onClick={() => inject({ mockFailRate: 0.3 })}>
              간헐 장애 (실패율 30%)
            </button>
          </div>
        </div>

        <div className="control-group">
          <h3>Graceful Degradation (과부하 시 뭘 포기할까)</h3>
          <div className="btn-row">
            {(["none", "no-tts", "cache-only", "reject"] as const).map((lv) => (
              <button
                key={lv}
                className={`ctl ${config?.degradation === lv ? "active" : ""}`}
                onClick={() => inject({ degradation: lv })}
              >
                {lv}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <h3>Rate Limiter (Token Bucket)</h3>
          <div className="btn-row">
            <button className="ctl" onClick={() => inject({ rateLimitEnabled: !config?.rateLimitEnabled })}>
              {config?.rateLimitEnabled ? "켜짐 → 끄기" : "꺼짐 → 켜기"}
            </button>
            <label className="slider">
              용량 {capDraft ?? config?.rateLimitCapacity ?? 5}
              <input
                type="range"
                min={1}
                max={50}
                value={capDraft ?? config?.rateLimitCapacity ?? 5}
                onChange={(e) => setCapDraft(Number(e.target.value))}
                onPointerUp={() => commit("rateLimitCapacity", capDraft, setCapDraft)}
                onKeyUp={() => commit("rateLimitCapacity", capDraft, setCapDraft)}
                onBlur={() => commit("rateLimitCapacity", capDraft, setCapDraft)}
              />
            </label>
            <label className="slider">
              회복 {refillDraft ?? config?.rateLimitRefillPerSec ?? 2}/s
              <input
                type="range"
                min={1}
                max={50}
                value={refillDraft ?? config?.rateLimitRefillPerSec ?? 2}
                onChange={(e) => setRefillDraft(Number(e.target.value))}
                onPointerUp={() => commit("rateLimitRefillPerSec", refillDraft, setRefillDraft)}
                onKeyUp={() => commit("rateLimitRefillPerSec", refillDraft, setRefillDraft)}
                onBlur={() => commit("rateLimitRefillPerSec", refillDraft, setRefillDraft)}
              />
            </label>
          </div>
        </div>

        <div className="control-group">
          <h3>부하 주입</h3>
          {metrics?.mockEnabled ? (
            <div className="btn-row">
              <button className="ctl" disabled={!!busy} onClick={() => withBusy("burst", () => fireLoad(30, true))}>
                {busy === "burst" ? "쏘는 중..." : "한 사용자 폭주 (30연발 → 429 보기)"}
              </button>
              <button className="ctl" disabled={!!busy} onClick={() => withBusy("spike", () => fireLoad(80, false))}>
                {busy === "spike" ? "쏘는 중..." : "대량 트래픽 (80동시, 여러 사용자)"}
              </button>
            </div>
          ) : (
            <p className="dash-note">
              이 배포는 실제 Gemini API를 쓰고 있어서 부하 주입 버튼을 껐어요(눌렀다간 진짜 요청이 실제
              무료 할당량을 그대로 태워요). MOCK_LLM 모드로 띄운 서버에서만 켜집니다.
            </p>
          )}
          <div className="btn-row">
            <button
              className="ctl"
              disabled={busy === "reset"}
              onClick={() =>
                withBusy("reset", async () => {
                  // 1초마다 도는 폴링과 타이밍이 어긋나면, 리셋 요청이 서버에 닿기 전에
                  // 폴링이 먼저 돌아 예전 값을 한 번 더 찍을 수 있다. 리셋이 끝난 뒤
                  // 곧바로 한 번 더 가져와서 화면이 기다리지 않고 바로 반영되게 한다.
                  try {
                    await resetAll();
                  } catch (e) {
                    // 서버가 거부했으면 아무것도 안 지워졌다. 그래프까지 비우면
                    // "초기화된 것처럼" 보여서 상태를 오해하게 된다.
                    if (isAuthError(e)) setNeedToken(true);
                    return;
                  }
                  setSeries([]);
                  prevRef.current = null;
                  try {
                    setMetrics(await fetchMetrics());
                  } catch {
                    /* 다음 폴링에서 채워진다 */
                  }
                })
              }
            >
              {busy === "reset" ? "초기화 중..." : "전체 초기화 (메트릭·서킷·대기열)"}
            </button>
          </div>
        </div>
      </div>

      {/* 이벤트 로그: 서킷 열림/닫힘, 관리자 조작 같은 굵직한 사건의 타임라인 */}
      <div className="control-group event-log">
        <h3>이벤트 로그</h3>
        {events.length === 0 ? (
          <p className="dash-note">아직 기록된 사건이 없어요.</p>
        ) : (
          <ul className="event-list">
            {events.map((e) => (
              <li key={e.ts + e.message} className={`event-item event-${e.type}`}>
                <span className="event-time">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="event-msg">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Card({ label, value, sub, tone, color }: { label: string; value: string; sub?: string; tone?: "ok" | "bad"; color?: string }) {
  return (
    <div className={`card ${tone === "bad" ? "card-bad" : ""}`}>
      <div className="card-label">{label}</div>
      <div className="card-value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}
