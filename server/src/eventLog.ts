// 대시보드에 "언제 무슨 일이 있었는지" 보여주기 위한 인메모리 이벤트 로그.
// 요청 단위 로그는 pino가 이미 다 찍으므로, 여기선 서킷 상태 전환과 관리자 조작처럼
// 방어 계층의 굵직한 사건만 추려서 보관한다(최근 maxEvents개, 순환 버퍼).

export type LogEvent = { ts: number; type: string; message: string };

class EventLog {
  private readonly events: LogEvent[] = [];
  private readonly max = 100;

  push(type: string, message: string): void {
    this.events.push({ ts: Date.now(), type, message });
    if (this.events.length > this.max) this.events.shift();
  }

  // 최신이 먼저 오도록 뒤집어서 준다
  list(): LogEvent[] {
    return [...this.events].reverse();
  }

  reset(): void {
    this.events.length = 0;
  }
}

export const eventLog = new EventLog();
