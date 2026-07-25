// 인메모리 메트릭 수집기. 부하 테스트의 결과를 수치로 증명하려면
// "요청 몇 건, 성공/실패/폴백/캐시히트 각 몇 건, 지연 p50/p95/p99"를 재야 한다.
// 외부 모니터링(Prometheus 등)을 붙이기 전에, 서버가 스스로 이 숫자를 들고 있게 한다.
// /api/metrics로 노출해 부하 스크립트가 before/after를 비교한다.
//
// 왜 평균이 아니라 백분위(p95/p99)인가:
// 평균은 소수의 느린 요청을 가려버린다. 사용자 체감은 "가장 느린 5%"에서 갈리므로
// p95(100건 중 95등의 지연), p99를 본다. 이게 실서비스 SLO의 기준이다.

class Metrics {
  private readonly counters = new Map<string, number>();
  // 지연 샘플. 메모리 상한을 위해 최근 maxSamples개만 순환 보관한다.
  private readonly latencies: number[] = [];
  private readonly maxSamples = 10000;
  private latencyCursor = 0;

  inc(key: string, by = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  recordLatency(ms: number): void {
    if (this.latencies.length < this.maxSamples) {
      this.latencies.push(ms);
    } else {
      // 상한에 닿으면 가장 오래된 자리를 덮어쓴다(순환 버퍼)
      this.latencies[this.latencyCursor] = ms;
      this.latencyCursor = (this.latencyCursor + 1) % this.maxSamples;
    }
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    // p번째 백분위 자리의 값. 예: p95 → 정렬된 배열의 95% 지점
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      counters: Object.fromEntries(this.counters),
      latency: {
        count: sorted.length,
        p50: this.percentile(sorted, 50),
        p95: this.percentile(sorted, 95),
        p99: this.percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
      },
    };
  }

  // 부하 테스트 사이에 초기화해서 회차별로 깨끗하게 잰다
  reset(): void {
    this.counters.clear();
    this.latencies.length = 0;
    this.latencyCursor = 0;
  }
}

// 서버 전역에서 하나를 공유한다
export const metrics = new Metrics();
