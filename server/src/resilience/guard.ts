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
import { Semaphore, SemaphoreResetError } from "./semaphore.js";
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
      // 관리자 초기화로 대기열에서 쫓겨난 호출의 거절은 외부 API의 실패가 아니다.
      // 이걸 거르지 않으면 reset() 직후 거절들이 실패로 집계돼 회로가 도로 열린다.
      ignore: (e) => e instanceof SemaphoreResetError,
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

  // 스트리밍 호출용. call()은 프로미스가 resolve되면 그 호출이 끝난 것으로 보지만,
  // LLM 스트리밍에서 resolve는 "이제부터 토큰이 흐른다"는 시작 신호일 뿐이다.
  // 그래서 여는 것만 call()로 감싸면 보호막 두 겹이 조용히 새 나간다.
  //   1) 세마포어 자리가 스트림이 열리자마자 반납된다. 동시 생성이 40개든 상한은
  //      TTFB 동안만 걸려, maxConcurrent가 실제 동시 호출 수를 전혀 못 막는다.
  //   2) 스트림 도중 죽는 실패가 서킷에 "성공"으로 기록된다. 헤더는 200으로 주고
  //      본문에서 에러를 뱉는 장애(SDK가 실제로 이렇게 실패한다)에는 회로가 영영 안 열린다.
  // 그래서 스트림을 다 쓸 때까지 자리와 서킷 판정을 붙들고 있는다.
  //
  // 두 가지는 의도적으로 다르게 뒀다.
  //  - 재시도는 "여는 것"에만 건다. 토큰이 한 번 흐른 뒤에 다시 부르면 이미 화면에
  //    나간 답 위에 중복으로 붙는다.
  //  - 백오프 대기 중에도 자리를 붙들고 있는다. call()은 대기 중엔 자리를 놓지만,
  //    여기선 곧 이어질 생성(5~7초)이 자리의 주된 사용처라 놓았다 다시 잡는 게
  //    이득이 없고, 그 틈에 다른 호출이 끼어들면 상한을 넘게 된다.
  async *callStream<T>(open: () => Promise<AsyncIterable<T>>): AsyncGenerator<T> {
    const settle = this.breaker.begin(); // 회로가 열려 있으면 여기서 즉시 실패
    let release: (() => void) | undefined;
    try {
      release = await this.semaphore.acquire();
      const stream = await withRetry(
        () => withTimeout(open(), this.opts.timeoutMs, this.opts.label),
        this.opts.label,
        this.retryDelays
      );
      for await (const chunk of stream) yield chunk;
    } catch (e) {
      settle(false, e);
      throw e;
    } finally {
      release?.();
      // 정상 종료뿐 아니라 소비자가 중간에 그만둔 경우(사용자가 탭을 닫아 clientGone)도
      // 여기로 온다. 그건 외부 API가 실패한 게 아니므로 성공으로 마감한다.
      // 마감을 아예 안 하면 half-open 시험표가 반납되지 않아 회로가 굳는다.
      settle(true);
    }
  }

  // 관리자가 대시보드에서 강제 초기화할 때 쓴다.
  // 주의: 대기자 거절은 프로미스라 마이크로태스크로 "나중에" 도착하므로, 호출 순서를
  // 어떻게 바꿔도 순서만으로는 서킷을 지킬 수 없다(거절 집계가 서킷 초기화 뒤에 실행됨).
  // 그래서 순서가 아니라 에러 분류로 해결한다 — 거절은 SemaphoreResetError로 던지고,
  // 서킷이 그 에러를 실패로 세지 않는다(ignore). 최종 상태가 항상 깨끗한 closed다.
  reset(): void {
    this.semaphore.reset();
    this.breaker.reset();
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
