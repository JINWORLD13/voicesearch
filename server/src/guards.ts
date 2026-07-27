// 외부 의존성마다 보호막(Guard)을 하나씩 둔다. API의 성격이 다르므로 값도 다르게 준다.
// 이 값들의 최종 근거는 부하 테스트다(loadtest/). 여기 적힌 건 그 출발점이다.

import { Guard } from "./resilience/index.js";

// 부하 실험용 토글: 같은 코드에서 before/after를 공정하게 비교하려는 것으로,
// 프로덕션에선 설정하지 않는다.
//   NO_RETRY=1   재시도를 끈다
//   NO_CIRCUIT=1 서킷 브레이커를 사실상 끈다(임계치를 무한대로 올려 절대 안 열리게)
const RETRY = process.env.NO_RETRY ? [] : [500, 1000, 2000];
const CIRCUIT = (n: number): number => (process.env.NO_CIRCUIT ? Number.MAX_SAFE_INTEGER : n);

// Gemini: LLM이라 원래 느리다(5~7초). 무료 등급은 분당 요청 제한이 빡빡하다.
// → 동시성을 낮게 잡아 rate limit을 넘지 않게 하고, 타임아웃은 넉넉히 준다.
export const geminiGuard = new Guard({
  label: "gemini",
  maxConcurrent: 8,
  timeoutMs: 30000,
  failureThreshold: CIRCUIT(5),
  resetMs: 10000,
  retryDelays: RETRY,
});

// OpenAI: 기본 경로는 아니지만 프로바이더를 바꿀 수 있으니 별도 보호막을 둔다.
export const openaiGuard = new Guard({
  label: "openai",
  maxConcurrent: 8,
  timeoutMs: 30000,
  failureThreshold: CIRCUIT(5),
  resetMs: 10000,
  retryDelays: RETRY,
});

// Exa: 검색 API는 LLM보다 빠르다. 타임아웃을 짧게 잡아 느린 검색을 빨리 포기하고
// 폴백이나 에러로 넘긴다.
export const exaGuard = new Guard({
  label: "exa",
  maxConcurrent: 10,
  timeoutMs: 15000,
  failureThreshold: CIRCUIT(5),
  resetMs: 10000,
  retryDelays: RETRY,
});

// ElevenLabs: 무료 한도가 작아 동시성을 낮게 둔다. 실패해도 브라우저 음성으로
// 폴백되므로 회로를 조금 더 예민하게(빨리) 열어도 사용자 경험이 안 깨진다.
export const elevenLabsGuard = new Guard({
  label: "elevenlabs",
  maxConcurrent: 4,
  timeoutMs: 30000,
  failureThreshold: CIRCUIT(4),
  resetMs: 15000,
  retryDelays: RETRY,
});

// 메트릭 엔드포인트에서 한 번에 상태를 보여주려고 모아둔다
export function guardMetrics() {
  return {
    gemini: geminiGuard.metrics,
    openai: openaiGuard.metrics,
    exa: exaGuard.metrics,
    elevenlabs: elevenLabsGuard.metrics,
  };
}

// 대시보드의 "전체 초기화"가 부른다. 부하 주입 등으로 큐/서킷이 막혔을 때
// Render 재시작 없이 복구할 수 있게 한다.
export function resetGuards(): void {
  geminiGuard.reset();
  openaiGuard.reset();
  exaGuard.reset();
  elevenLabsGuard.reset();
}
