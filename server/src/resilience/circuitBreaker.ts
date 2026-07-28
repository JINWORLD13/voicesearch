// 외부 API가 계속 실패하면 잠시 호출을 아예 멈춘다.
// 죽은 API에 요청을 계속 던지면, 매 요청이 타임아웃까지 매달렸다가 실패한다.
// 사용자는 5초씩 기다렸다 에러를 받고, 서버 자원도 헛되이 묶인다.
// 그래서 실패가 쌓이면 회로를 "열어(open)" 한동안 즉시 실패시키고,
// 식은 뒤 한 번만 시험 호출(half-open)해서 살아났는지 확인한다.
//
// 상태 세 가지:
//  closed    정상. 그대로 호출을 통과시킨다.
//  open      차단. 즉시 실패(빠른 실패). resetMs가 지나면 half-open으로.
//  half-open 시험. 딱 한 번 통과시켜 본다. 성공하면 closed, 실패하면 다시 open.

import { eventLog } from "../eventLog.js";

type State = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  constructor(public readonly label: string) {
    super(`${label} 회로 열림 — 일시적으로 호출을 차단합니다`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: State = "closed";
  private failures = 0;
  private openedAt = 0;
  private shortCircuited = 0; // 차단으로 즉시 실패시킨 횟수(관측용)

  constructor(
    private readonly opts: {
      failureThreshold: number;
      resetMs: number;
      label: string;
      // 실패로 세지 않을 에러를 거른다(resilience4j의 ignoreExceptions에 해당).
      // 예: 관리자가 대기열을 초기화해 생긴 취소는 외부 API의 실패가 아니므로
      // 회로를 여는 근거가 되면 안 된다. 에러 자체는 그대로 호출자에게 던진다.
      ignore?: (err: unknown) => boolean;
    }
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.opts.resetMs) {
        // 식을 만큼 식었으니 시험 삼아 한 번 열어본다
        this.state = "half-open";
        eventLog.push("circuit", `${this.opts.label} 서킷 half-open — 시험 호출 시작`);
      } else {
        // 아직 식지 않았다. 실제 호출 없이 즉시 실패시킨다(빠른 실패)
        this.shortCircuited++;
        throw new CircuitOpenError(this.opts.label);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (!this.opts.ignore?.(err)) this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    // 시험 호출이 성공했거나 정상 호출이 성공했다. 실패 기록을 지우고 정상으로.
    const wasOpenish = this.state !== "closed";
    this.failures = 0;
    this.state = "closed";
    if (wasOpenish) eventLog.push("circuit", `${this.opts.label} 서킷 closed — 복구됨`);
  }

  private onFailure(): void {
    this.failures++;
    // half-open에서 실패했거나(아직 안 나았다), 실패가 임계치를 넘으면 회로를 연다
    if (this.state === "half-open" || this.failures >= this.opts.failureThreshold) {
      const wasOpen = this.state === "open";
      this.state = "open";
      this.openedAt = Date.now();
      if (!wasOpen) eventLog.push("circuit", `${this.opts.label} 서킷 open — 실패 ${this.failures}회 누적`);
    }
  }

  // 관리자가 대시보드에서 강제로 정상 상태로 되돌릴 때 쓴다(장애 주입 후 실험 종료 등)
  reset(): void {
    const wasOpenish = this.state !== "closed";
    this.state = "closed";
    this.failures = 0;
    this.openedAt = 0;
    this.shortCircuited = 0;
    if (wasOpenish) eventLog.push("circuit", `${this.opts.label} 서킷 강제 초기화`);
  }

  get snapshot() {
    return { state: this.state, failures: this.failures, shortCircuited: this.shortCircuited };
  }
}
