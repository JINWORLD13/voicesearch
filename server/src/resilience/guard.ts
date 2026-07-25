// 외부 API 호출 하나를 여러 겹의 보호막으로 감싼다.
// 겹의 순서에는 이유가 있다(바깥 → 안쪽).
//
//   서킷 브레이커   계속 죽는 API면 실제 호출조차 하지 않고 즉시 실패시킨다
//     └ 재시도       일시적 오류(429/5xx)면 몇 번 더 시도한다
//         └ 세마포어  실제 호출 순간에만 동시 실행 슬롯을 잡는다(백오프 대기 중엔 슬롯을 놓는다)
//             └ 타임아웃  개별 호출이 매달리지 않게 상한 시간을 건다
//
// 이렇게 하면 "죽은 API 빠른 실패 / 일시 오류 회복 / rate limit 보호 / 무한 대기 차단"이
// 한 번의 call()로 전부 걸린다. 외부 의존성(gemini, exa, elevenlabs)마다 하나씩 둔다.

import { CircuitBreaker } from "./circuitBreaker.js";
import { Semaphore } from "./semaphore.js";
import { withTimeout } from "./timeout.js";

// 일시적 오류만 재시도한다. 400/401/404처럼 고쳐도 안 되는 오류는 바로 던진다.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// SDK마다 상태 코드가 e.status(@google/genai) 또는 e.response.status(axios)에 온다.
// 에러 분류가 필요한 곳(재시도 판단, 사용자 메시지)은 전부 이 함수를 거쳐 한 곳에서 흡수한다.
export function statusOf(e: unknown): number | undefined {
  const anyErr = e as { status?: number; response?: { status?: number } };
  return anyErr?.status ?? anyErr?.response?.status;
}

async function withRetry<T>(fn: () => Promise<T>, label: string, delays: number[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = statusOf(e);
      // 재시도 대상이 아니거나(상태 코드가 없거나 non-retryable) 횟수를 다 썼으면 던진다
      if (!status || !RETRYABLE.has(status) || attempt >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

export type GuardOptions = {
  label: string;
  maxConcurrent: number; // 동시에 이 API로 나갈 수 있는 최대 요청 수
  timeoutMs: number; // 개별 호출 상한 시간
  failureThreshold: number; // 이만큼 연속 실패하면 회로를 연다
  resetMs: number; // 회로를 연 뒤 이만큼 지나면 시험 호출을 해본다
  retryDelays?: number[]; // 재시도 간격(길이 = 재시도 횟수)
};

export class Guard {
  private readonly breaker: CircuitBreaker;
  private readonly semaphore: Semaphore;
  private readonly retryDelays: number[];

  constructor(private readonly opts: GuardOptions) {
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.failureThreshold,
      resetMs: opts.resetMs,
      label: opts.label,
    });
    this.semaphore = new Semaphore(opts.maxConcurrent);
    this.retryDelays = opts.retryDelays ?? [500, 1000, 2000];
  }

  call<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.run(() =>
      withRetry(
        () => this.semaphore.run(() => withTimeout(fn(), this.opts.timeoutMs, this.opts.label)),
        this.opts.label,
        this.retryDelays
      )
    );
  }

  // 관측용: 이 의존성의 현재 상태를 메트릭으로 노출
  get metrics() {
    return {
      circuit: this.breaker.snapshot,
      inUse: this.semaphore.inUse,
      queued: this.semaphore.queued,
    };
  }
}
