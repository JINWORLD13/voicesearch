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
  private trialInFlight = false; // half-open 시험 호출이 지금 나가 있는가

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

  // 호출 하나의 "시작"을 등록한다. 회로가 닫혀 있지 않으면 여기서 즉시 실패시킨다.
  // 돌려주는 함수는 그 호출의 "끝"을 알리는 마감표다. 시작과 끝을 굳이 나눈 이유:
  // 스트리밍 호출은 프로미스가 resolve되는 시점(스트림이 열린 순간)이 끝이 아니라
  // 시작이라, run()처럼 한 프로미스로는 성공/실패를 제 시점에 기록할 수 없다.
  begin(): (ok: boolean, err?: unknown) => void {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.opts.resetMs) {
        // 식을 만큼 식었으니 시험 삼아 한 번 열어본다
        this.state = "half-open";
        this.trialInFlight = false;
        eventLog.push("circuit", `${this.opts.label} 서킷 half-open — 시험 호출 시작`);
      } else {
        // 아직 식지 않았다. 실제 호출 없이 즉시 실패시킨다(빠른 실패)
        this.shortCircuited++;
        throw new CircuitOpenError(this.opts.label);
      }
    }

    // half-open은 말 그대로 "딱 한 번" 시험해 보는 상태다. 시험 호출이 이미 나가 있으면
    // 나머지는 여전히 빠른 실패로 돌려보낸다. 이 문지기가 없으면 resetMs가 지나는 순간
    // 밀려 있던 요청이 전부 죽은 API로 한꺼번에 쏟아진다 — 회로를 연 목적이 사라진다.
    let trial = false;
    if (this.state === "half-open") {
      if (this.trialInFlight) {
        this.shortCircuited++;
        throw new CircuitOpenError(this.opts.label);
      }
      this.trialInFlight = true;
      trial = true;
    }

    let settled = false;
    return (ok, err) => {
      if (settled) return; // 마감은 한 번만 먹는다(중복 호출은 무해하게 무시)
      settled = true;
      if (trial) this.trialInFlight = false;
      if (ok) this.onSuccess();
      else if (!this.opts.ignore?.(err)) this.onFailure();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const settle = this.begin();
    try {
      const result = await fn();
      settle(true);
      return result;
    } catch (err) {
      settle(false, err);
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
    this.trialInFlight = false;
    if (wasOpenish) eventLog.push("circuit", `${this.opts.label} 서킷 강제 초기화`);
  }

  get snapshot() {
    return { state: this.state, failures: this.failures, shortCircuited: this.shortCircuited };
  }
}
