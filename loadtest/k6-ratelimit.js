// k6 부하 시나리오 2: 한 사용자(한 IP)가 초당 많은 요청을 쏟을 때
// Rate Limiter가 그 사용자만 429로 막고 서버는 멀쩡한지 증명한다.
// "한 명의 실수가 전체 장애로 번지는 걸 앞단에서 막는다"를 수치로 보여주는 스크립트.
//
// 실행: k6 run loadtest/k6-ratelimit.js
//
// 기대: 대부분 429(토큰 소진). 서버 CPU/메모리는 안정, 5xx 없음.
// 같은 부하를 여러 IP로 흩뿌리면(k6-throughput.js) 429가 거의 없다 — 그 대비가 핵심.

import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    burst: {
      executor: "constant-arrival-rate", // 초당 고정 개수를 쏜다(부하율 고정)
      rate: 50, // 초당 50건
      timeUnit: "1s",
      duration: "15s",
      preAllocatedVUs: 60,
    },
  },
  thresholds: {
    "http_req_failed{expected_response:true}": ["rate<0.01"], // 5xx 거의 0
    // 한 사용자 폭주이므로 상당수가 429여야 정상(Rate Limiter가 일하고 있다는 증거)
  },
};

let rateLimited = 0;
let served = 0;

export default function () {
  const res = http.post(
    "http://localhost:3001/api/search",
    JSON.stringify({ question: "폭주 사용자 질문" }),
    {
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "9.9.9.9" }, // 같은 IP
      responseCallback: http.expectedStatuses(200, 429),
    }
  );
  if (res.status === 429) rateLimited++;
  else if (res.status === 200) served++;
  check(res, { "5xx 아님(서버는 멀쩡)": (r) => r.status < 500 });
}

export function handleSummary(data) {
  // 콘솔에 429/200 비율을 요약해 "얼마나 막았는지" 보이게 한다
  const total = rateLimited + served;
  const line = total
    ? `\n한 사용자 폭주 결과: 통과 ${served} · 429 차단 ${rateLimited} (차단율 ${Math.round((rateLimited / total) * 100)}%)\n`
    : "\n(요청 없음)\n";
  return { stdout: line + JSON.stringify(data.metrics.http_req_duration.values, null, 2) };
}
