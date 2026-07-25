// 외부 호출이 정해진 시간 안에 안 끝나면 강제로 실패시킨다.
// LLM이나 검색 API가 응답 없이 매달리면, 그 요청 하나가 서버 자원(연결, 메모리)을
// 붙잡고 놓지 않는다. 부하가 몰릴 때 이런 매달린 요청이 쌓이면 서버가 멈춘다.
// 그래서 모든 외부 호출에 상한 시간을 건다.

export class TimeoutError extends Error {
  constructor(
    public readonly ms: number,
    public readonly label: string
  ) {
    super(`${label} ${ms}ms 초과`);
    this.name = "TimeoutError";
  }
}

// promise가 ms 안에 끝나면 그 결과를, 아니면 TimeoutError를 던진다.
// 이긴 쪽만 반영하고 진 타이머는 정리해서 누수를 막는다.
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "작업"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
