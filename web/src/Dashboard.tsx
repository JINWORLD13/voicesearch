import { useEffect, useRef, useState } from "react";
import {
  fetchMetrics,
  fetchConfig,
  injectConfig,
  resetMetrics,
  fireLoad,
  type Metrics,
  type RuntimeConfig,
} from "./api";
import "./Dashboard.css";

type Point = { p50: number; p95: number; rate: number };

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
  const [series, setSeries] = useState<Point[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const prevRef = useRef<{ total: number; t: number } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchConfig().then((c) => alive && setConfig(c)).catch(() => {});

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
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function inject(patch: Partial<RuntimeConfig>) {
    await injectConfig(patch);
    fetchConfig().then(setConfig).catch(() => {});
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
        <Card label="총 유입" value={String(ingress)} sub={`처리 ${served} · 429 ${rateLimited}`} />
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
              용량 {config?.rateLimitCapacity ?? 5}
              <input type="range" min={1} max={50} value={config?.rateLimitCapacity ?? 5} onChange={(e) => inject({ rateLimitCapacity: Number(e.target.value) })} />
            </label>
            <label className="slider">
              회복 {config?.rateLimitRefillPerSec ?? 2}/s
              <input type="range" min={1} max={50} value={config?.rateLimitRefillPerSec ?? 2} onChange={(e) => inject({ rateLimitRefillPerSec: Number(e.target.value) })} />
            </label>
          </div>
        </div>

        <div className="control-group">
          <h3>부하 주입</h3>
          <div className="btn-row">
            <button className="ctl" disabled={!!busy} onClick={() => withBusy("burst", () => fireLoad(30, true))}>
              {busy === "burst" ? "쏘는 중..." : "한 사용자 폭주 (30연발 → 429 보기)"}
            </button>
            <button className="ctl" disabled={!!busy} onClick={() => withBusy("spike", () => fireLoad(80, false))}>
              {busy === "spike" ? "쏘는 중..." : "대량 트래픽 (80동시, 여러 사용자)"}
            </button>
            <button className="ctl" onClick={() => { resetMetrics(); setSeries([]); prevRef.current = null; }}>
              메트릭 초기화
            </button>
          </div>
        </div>
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
