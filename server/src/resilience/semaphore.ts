// 외부 API에 동시에 던지는 요청 수를 제한한다.
// 무제한으로 던지면 두 가지가 터진다.
//  1) 외부 API의 rate limit(429)에 걸려 오히려 전부 실패한다.
//  2) 응답을 기다리는 연결이 서버에 쌓여 메모리/소켓 자원이 고갈된다.
// 그래서 "한 번에 max개까지만 실행, 나머지는 줄 세우기"로 흐름을 고른다.

type Waiter = { resolve: () => void; reject: (e: Error) => void };

// 관리자 초기화(reset)로 대기열에서 쫓겨난 대기자가 받는 에러.
// 일반 Error가 아니라 전용 클래스로 던지는 이유: 이 거절은 "외부 API가 실패했다"가
// 아니라 "우리가 스스로 취소했다"라서, 서킷 브레이커가 실패로 세면 안 된다.
// guard.ts가 이 클래스를 보고 서킷의 실패 집계에서 제외한다.
export class SemaphoreResetError extends Error {
  constructor() {
    super("관리자가 대기열을 초기화해 호출이 취소됨");
    this.name = "SemaphoreResetError";
  }
}

export class Semaphore {
  private permits: number; // 지금 남은 자리 수
  private readonly queue: Waiter[] = []; // 자리를 기다리는 사람들

  constructor(private readonly max: number) {
    this.permits = max;
  }

  // 자리를 하나 확보한다. 자리가 없으면 날 때까지 기다린다.
  private take(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    // 자리가 없으면 큐에 대기표를 넣고, release가 깨워줄 때까지 멈춘다
    return new Promise<void>((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  // 자리를 잡고 "반납표"를 돌려준다. run()은 fn이 끝나는 시점이 곧 반납 시점이지만,
  // 스트리밍 호출은 프로미스가 끝나도(스트림이 열려도) 일이 한참 남아 있어서
  // 자기가 직접 자리를 붙들고 있다가 다 쓰고 반납해야 한다. 그 경로를 위해 연다.
  // 반납표는 여러 번 불러도 한 번만 먹는다(이중 반납으로 자리 수가 어긋나지 않게).
  async acquire(): Promise<() => void> {
    await this.take();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
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
  // 아직 순서를 기다리던 대기자만 즉시 SemaphoreResetError로 떨어뜨려 큐를 비운다.
  reset(): void {
    const waiting = this.queue.splice(0, this.queue.length);
    for (const w of waiting) w.reject(new SemaphoreResetError());
  }

  // fn을 자리 안에서 실행하고, 끝나면(성공이든 실패든) 자리를 반납한다.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
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
