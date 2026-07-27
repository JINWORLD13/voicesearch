// Rate Limiter — 한 사용자(IP)가 짧은 시간에 요청을 폭주시켜 서버와 외부 AI를
// 마비시키는 걸 가장 앞단에서 막는다. "한 명의 실수가 전체 장애로 번지는 것"을 차단.
//
// 왜 Token Bucket 알고리즘인가 (대안 비교):
//   Fixed Window(고정 창): 1분에 60개. 구현은 쉽지만 창 경계에서 문제.
//     59초에 60개 + 61초에 60개 = 2초 만에 120개가 통과한다(경계 버스트).
//   Sliding Window(이동 창): 정확하지만 요청 시각을 다 기록해야 해 메모리/계산이 비싸다.
//   Leaky Bucket(새는 양동이): 일정 속도로만 처리. 짧은 정상 버스트도 못 봐준다.
//   Token Bucket: 평소엔 버킷에 토큰이 차 있어 순간 버스트(capacity까지)를 허용하고,
//     지속 요청은 refill 속도로 제한한다. "가끔 몰아치지만 평균은 낮은" 트래픽
//     (검색/채팅)에 가장 잘 맞아서 골랐다.
//
// 핵심 아이디어: 타이머로 토큰을 채우지 않는다(요청마다 타이머를 돌리면 낭비).
// 요청이 올 때 "마지막 채운 시각 ~ 지금" 사이 흐른 시간만큼 토큰을 계산해서 채운다(지연 계산).

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number, // 버킷 최대 크기 = 허용 가능한 순간 버스트
    private readonly refillPerSec: number // 초당 채워지는 토큰 수 = 지속 허용 속도
  ) {
    this.tokens = capacity; // 시작은 가득 찬 상태
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    // 흐른 시간 × 초당 회복량 만큼 채우되, 최대 capacity를 넘지 않는다
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  // 토큰 1개를 쓰려 시도한다. 있으면 소비하고 true, 없으면 false(거부).
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  // 관측/디버깅용: 지금 남은 토큰(정수로)
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private lastSweep = Date.now();

  constructor(
    private readonly getCapacity: () => number,
    private readonly getRefillPerSec: () => number
  ) {}

  // key(보통 IP)별로 버킷을 두고, 그 버킷에서 토큰을 하나 쓴다.
  // 설정값을 함수로 받는 이유: 대시보드가 런타임에 강도를 바꿔도 즉시 반영되게.
  allow(key: string): boolean {
    this.sweepIfNeeded();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.getCapacity(), this.getRefillPerSec());
      this.buckets.set(key, bucket);
    }
    return bucket.tryConsume();
  }

  // 오래 안 쓴 IP의 버킷이 무한정 쌓이는 걸 막는다(메모리 누수 방지).
  // 5분에 한 번, 가득 찬(=한동안 요청 없던) 버킷을 정리한다.
  private sweepIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastSweep < 5 * 60 * 1000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.available >= this.getCapacity()) this.buckets.delete(key);
    }
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }

  // 관리자 강제 초기화용: 모든 IP의 버킷을 지워 다시 가득 찬 상태에서 시작하게 한다.
  reset(): void {
    this.buckets.clear();
  }
}
