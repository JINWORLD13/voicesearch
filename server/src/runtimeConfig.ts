// 런타임에 바꿀 수 있는 설정. 대시보드에서 장애를 주입하고 방어 로직이 발동하는 걸
// 실시간으로 관찰하려면, 실패율/지연/rate limit을 서버 재시작 없이 바꿔야 한다.
// env는 시작값일 뿐이고, 이후 실효값은 이 store가 들고 있다.
//
// 이 store가 있어서 포폴 데모가 성립한다: "외부 AI를 죽여보자(실패율 100%)" 버튼을
// 누르면 이 값이 바뀌고, 다음 요청부터 서킷이 열리는 걸 그래프로 볼 수 있다.

import { eventLog } from "./eventLog.js";

export type DegradationLevel =
  | "none" // 정상: 검색 + 스트리밍 + 음성 전부 제공
  | "no-tts" // 1단계 저하: 음성 합성 포기(텍스트만). TTS가 가장 무겁고 덜 중요
  | "cache-only" // 2단계 저하: 캐시된 답만 제공, 새 외부 호출 거부
  | "reject"; // 최후: 검색 자체를 잠시 거부(핵심 자원 보호)

// 숫자로 쓸 수 있는 값만 통과시킨다. Number()는 "abc"·{}·null·true를 조용히
// NaN이나 0으로 바꾸는데, NaN이 설정에 박히면 조용히 넘어가지 않는다:
// clamp가 NaN을 그대로 흘려보내고(Math.max(1, Math.min(10000, NaN)) === NaN),
// 그 NaN이 rateLimitCapacity에 앉으면 TokenBucket의 tokens가 NaN이 되어
// tryConsume()의 `NaN >= 1`이 영원히 false — 즉 모든 IP가 429로 막힌다.
// 관리 엔드포인트가 기본적으로 열려 있으므로(server.ts) 이 문은 반드시 닫아야 한다.
function toFinite(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined; // null, undefined, {}, [], true, "", "abc", Infinity, NaN
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// 환경변수도 사람이 손으로 넣는 값이라 같은 위험이 있다(RATE_LIMIT_CAPACITY=abc면
// 서버가 아예 못 쓰는 상태로 뜬다). 숫자로 못 읽히면 조용히 기본값으로 돌린다.
function envNum(name: string, fallback: number, lo: number, hi: number): number {
  const n = toFinite(process.env[name]);
  return n === undefined ? fallback : clamp(n, lo, hi);
}

export const runtimeConfig = {
  // 외부 AI(mock) 장애 주입용. 실제 배포에선 MOCK_LLM 미설정이라 안 쓰이고,
  // 데모/부하에서만 이 값으로 "느리고 실패하는 외부 API"를 재현한다.
  mockFailRate: envNum("MOCK_LLM_FAIL_RATE", 0, 0, 1),
  mockMinMs: envNum("MOCK_LLM_MIN_MS", 2000, 0, 60000),
  mockMaxMs: envNum("MOCK_LLM_MAX_MS", 6000, 0, 60000),

  // Rate Limiter (IP별 Token Bucket)
  rateLimitEnabled: !process.env.RATE_LIMIT_OFF,
  rateLimitCapacity: envNum("RATE_LIMIT_CAPACITY", 5, 1, 10000), // 순간 최대 버스트
  rateLimitRefillPerSec: envNum("RATE_LIMIT_REFILL", 2, 0.1, 10000), // 초당 회복 토큰

  // Graceful Degradation 레벨(과부하 시 뭘 포기할지)
  degradation: "none" as DegradationLevel,
};

// 시작 시점의 값을 복사해 둔다. 자동 정상화가 되돌아갈 기준점.
const defaults = { ...runtimeConfig };

// 자동 정상화: 관리 기능이 공개돼 있어서, 방문자가 "reject" 같은 저하를 걸어두고
// 떠나면 다음 방문자는 이유도 모른 채 실패만 본다. 그래서 마지막 관리 조작 후
// 10분이 지나면 설정을 시작값으로 되돌린다(조작이 이어지면 타이머도 미뤄진다).
// unref()로 이 타이머가 프로세스 종료를 막지 않게 한다.
const REVERT_AFTER_MS = 10 * 60 * 1000;
let revertTimer: NodeJS.Timeout | undefined;

function scheduleAutoRevert(): void {
  if (revertTimer) clearTimeout(revertTimer);
  revertTimer = setTimeout(() => {
    revertTimer = undefined;
    const changed = JSON.stringify(runtimeConfig) !== JSON.stringify(defaults);
    Object.assign(runtimeConfig, defaults);
    if (changed) eventLog.push("admin", "관리 조작 후 10분 경과 — 설정을 자동 정상화");
  }, REVERT_AFTER_MS);
  revertTimer.unref();
}

// 대시보드가 보내는 부분 갱신을 안전 범위로 반영한다
export function patchConfig(patch: Record<string, unknown>): void {
  scheduleAutoRevert();
  // 숫자로 못 읽히는 값은 반영하지 않고 기존 값을 유지한다(잘못 보낸 한 번의 요청이
  // 설정을 망가뜨리지 않게). 유효한 값만 안전 범위로 접어서 넣는다.
  const setNum = (key: "mockFailRate" | "mockMinMs" | "mockMaxMs" | "rateLimitCapacity" | "rateLimitRefillPerSec", lo: number, hi: number) => {
    if (!(key in patch)) return;
    const n = toFinite(patch[key]);
    if (n !== undefined) runtimeConfig[key] = clamp(n, lo, hi);
  };
  setNum("mockFailRate", 0, 1);
  setNum("mockMinMs", 0, 60000);
  setNum("mockMaxMs", 0, 60000);
  setNum("rateLimitCapacity", 1, 10000);
  setNum("rateLimitRefillPerSec", 0.1, 10000);
  if ("rateLimitEnabled" in patch) runtimeConfig.rateLimitEnabled = Boolean(patch.rateLimitEnabled);
  if ("degradation" in patch) {
    const levels: DegradationLevel[] = ["none", "no-tts", "cache-only", "reject"];
    if (levels.includes(patch.degradation as DegradationLevel)) {
      runtimeConfig.degradation = patch.degradation as DegradationLevel;
    }
  }
}
