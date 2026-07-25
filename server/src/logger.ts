// 구조화 로깅. console.log는 사람이 눈으로 읽는 용도라, 나중에 "429가 몇 번 났지",
// "p95 지연이 언제 튀었지"를 기계로 집계할 수 없다. pino는 로그를 JSON 한 줄로 남긴다.
// { "level":30, "time":..., "reqId":"...", "event":"search.done", "latencyMs":4980 }
// 이렇게 남기면 나중에 로그를 그대로 검색/집계/대시보드에 태울 수 있다.
//
// 왜 로깅은 직접 안 만들고 라이브러리(pino)를 쓰나:
// 세마포어나 캐시는 로직이 짧고 이 프로젝트에 맞게 통제하고 싶어 직접 짰지만,
// 로깅은 비동기 flush, 로그 레벨, 자식 로거 같은 검증된 기능이 이미 다 필요하고
// 직접 만들면 재발명이라, 표준 도구를 쓰는 게 맞다고 봤다.

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // 부하 테스트 때 로그 자체가 병목이 되지 않게 최소 형식으로 남긴다
  base: undefined, // pid, hostname 같은 기본 필드 생략
});

// 요청마다 자식 로거를 만들어 reqId를 붙인다.
// 한 요청에서 나온 로그들을 나중에 reqId로 묶어 볼 수 있다.
export function requestLogger(reqId: string) {
  return logger.child({ reqId });
}
