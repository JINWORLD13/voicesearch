// 같은 질문이 다시 오면 저장해둔 답을 즉시 준다. LLM 호출(5~7초 + 토큰 비용)을
// 통째로 건너뛴다. 인기 질문이 반복되는 검색 서비스에서 효과가 크다.
//
// 두 가지 기준으로 버린다.
//  LRU(Least Recently Used): 자리가 꽉 차면 가장 오래 안 쓴 것부터 버려 메모리 상한을 지킨다.
//  TTL(Time To Live): 웹 검색 결과는 시간이 지나면 낡으므로, 일정 시간이 지나면 만료시킨다.
//
// 자바스크립트 Map은 "넣은 순서"를 기억한다. 이 성질을 LRU에 그대로 쓴다.
// 쓸 때마다 지웠다 다시 넣으면 그 항목이 순서상 맨 뒤로 가고, 맨 앞이 가장 오래된 것이 된다.

type Entry<V> = { value: V; expiresAt: number };

export class LruTtlCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      // 만료됐으면 없는 것과 같다. 지우고 miss 처리.
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // 방금 썼으니 맨 뒤로 옮긴다(최근 사용 표시)
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V): void {
    // 이미 있으면 지웠다 다시 넣어 맨 뒤로(최신) 오게 한다
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });

    // 상한을 넘으면 가장 오래된 것(맨 앞)부터 버린다
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  // 관측용: 적중률은 캐시가 실제로 일을 하는지 보여주는 핵심 지표
  get stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }
}
