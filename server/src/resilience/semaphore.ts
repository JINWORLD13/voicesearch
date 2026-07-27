// 외부 API에 동시에 던지는 요청 수를 제한한다.
// 무제한으로 던지면 두 가지가 터진다.
//  1) 외부 API의 rate limit(429)에 걸려 오히려 전부 실패한다.
//  2) 응답을 기다리는 연결이 서버에 쌓여 메모리/소켓 자원이 고갈된다.
// 그래서 "한 번에 max개까지만 실행, 나머지는 줄 세우기"로 흐름을 고른다.

type Waiter = { resolve: () => void; reject: (e: Error) => void };

export class Semaphore {
  private permits: number; // 지금 남은 자리 수
  private readonly queue: Waiter[] = []; // 자리를 기다리는 사람들

  constructor(private readonly max: number) {
    this.permits = max;
  }

  // 자리를 하나 확보한다. 자리가 없으면 날 때까지 기다린다.
  private acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    // 자리가 없으면 큐에 대기표를 넣고, release가 깨워줄 때까지 멈춘다
    return new Promise<void>((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  // 자리를 반납한다. 기다리는 사람이 있으면 그 사람에게 자리를 바로 넘긴다.
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve(); // 자리 수는 그대로 두고(내가 비운 자리를 그대로 넘김) 대기자를 깨운다
    } else {
      this.permits++; // 기다리는 사람이 없으면 자리를 되돌려 놓는다
    }
  }

  // 부하 테스트로 쌓인 대기열을 관리자가 강제로 비운다. 이미 자리를 잡고 실행 중인
  // 호출(inUse)은 건드리지 않는다 — 그 호출들은 끝나면 각자 release()로 자리를
  // 정상 반납할 것이므로, 여기서 permits를 만지면 반납이 이중으로 잡혀 어긋난다.
  // 아직 순서를 기다리던 대기자만 즉시 에러로 떨어뜨려 큐를 비운다.
  reset(): void {
    const waiting = this.queue.splice(0, this.queue.length);
    for (const w of waiting) w.reject(new Error("관리자가 대기열을 초기화해 호출이 취소됨"));
  }

  // fn을 자리 안에서 실행하고, 끝나면(성공이든 실패든) 자리를 반납한다.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  // 관측용: 지금 몇 개가 실행 중이고 몇 개가 줄 서 있는지
  get inUse(): number {
    return this.max - this.permits;
  }
  get queued(): number {
    return this.queue.length;
  }
}
