// 런타임에 바꿀 수 있는 설정. 대시보드에서 장애를 주입하고 방어 로직이 발동하는 걸
// 실시간으로 관찰하려면, 실패율/지연/rate limit을 서버 재시작 없이 바꿔야 한다.
// env는 시작값일 뿐이고, 이후 실효값은 이 store가 들고 있다.
//
// 이 store가 있어서 포폴 데모가 성립한다: "외부 AI를 죽여보자(실패율 100%)" 버튼을
// 누르면 이 값이 바뀌고, 다음 요청부터 서킷이 열리는 걸 그래프로 볼 수 있다.

export type DegradationLevel =
  | "none" // 정상: 검색 + 스트리밍 + 음성 전부 제공
  | "no-tts" // 1단계 저하: 음성 합성 포기(텍스트만). TTS가 가장 무겁고 덜 중요
  | "cache-only" // 2단계 저하: 캐시된 답만 제공, 새 외부 호출 거부
  | "reject"; // 최후: 검색 자체를 잠시 거부(핵심 자원 보호)

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export const runtimeConfig = {
  // 외부 AI(mock) 장애 주입용. 실제 배포에선 MOCK_LLM 미설정이라 안 쓰이고,
  // 데모/부하에서만 이 값으로 "느리고 실패하는 외부 API"를 재현한다.
  mockFailRate: clamp(Number(process.env.MOCK_LLM_FAIL_RATE ?? 0), 0, 1),
  mockMinMs: Number(process.env.MOCK_LLM_MIN_MS ?? 2000),
  mockMaxMs: Number(process.env.MOCK_LLM_MAX_MS ?? 6000),

  // Rate Limiter (IP별 Token Bucket)
  rateLimitEnabled: !process.env.RATE_LIMIT_OFF,
  rateLimitCapacity: Number(process.env.RATE_LIMIT_CAPACITY ?? 5), // 순간 최대 버스트
  rateLimitRefillPerSec: Number(process.env.RATE_LIMIT_REFILL ?? 2), // 초당 회복 토큰

  // Graceful Degradation 레벨(과부하 시 뭘 포기할지)
  degradation: "none" as DegradationLevel,
};

// 대시보드가 보내는 부분 갱신을 안전 범위로 반영한다
export function patchConfig(patch: Record<string, unknown>): void {
  if ("mockFailRate" in patch) runtimeConfig.mockFailRate = clamp(Number(patch.mockFailRate), 0, 1);
  if ("mockMinMs" in patch) runtimeConfig.mockMinMs = clamp(Number(patch.mockMinMs), 0, 60000);
  if ("mockMaxMs" in patch) runtimeConfig.mockMaxMs = clamp(Number(patch.mockMaxMs), 0, 60000);
  if ("rateLimitEnabled" in patch) runtimeConfig.rateLimitEnabled = Boolean(patch.rateLimitEnabled);
  if ("rateLimitCapacity" in patch) runtimeConfig.rateLimitCapacity = clamp(Number(patch.rateLimitCapacity), 1, 10000);
  if ("rateLimitRefillPerSec" in patch) runtimeConfig.rateLimitRefillPerSec = clamp(Number(patch.rateLimitRefillPerSec), 0.1, 10000);
  if ("degradation" in patch) {
    const levels: DegradationLevel[] = ["none", "no-tts", "cache-only", "reject"];
    if (levels.includes(patch.degradation as DegradationLevel)) {
      runtimeConfig.degradation = patch.degradation as DegradationLevel;
    }
  }
}
