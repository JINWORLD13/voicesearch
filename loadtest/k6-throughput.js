// k6 부하 시나리오 1: 동시 접속을 단계적으로 늘리며 처리량과 지연을 측정한다.
// "동시 N명까지는 p95 X ms 이내, 그 이상부터는 Rate Limiter가 429로 안전 처리"를
// 그래프로 뽑기 위한 스크립트. VU마다 다른 가상 IP를 써서 정상 트래픽을 흉내낸다.
//
// 실행:
//   brew install k6                 # 최초 1회 (macOS)
//   # 데모(mock) 서버를 띄운 상태에서:
//   #   cd server && MOCK_LLM=1 MOCK_LLM_MIN_MS=300 MOCK_LLM_MAX_MS=1000 npm start
//   k6 run loadtest/k6-throughput.js
//
// 자체 스크립트(loadtest/run.mts)와 병행하는 이유: run.mts는 SSE done까지 읽어
// 캐시/폴백 같은 시나리오 지표를 잡고, k6는 표준 도구로 처리량/지연 분포와
// 임계(threshold) 자동 판정을 제공한다. 둘의 목적이 다르다.

import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus", // 동시 접속(VU)을 시간에 따라 늘렸다 줄인다
      startVUs: 0,
      stages: [
        { duration: "10s", target: 20 }, // 워밍업
        { duration: "20s", target: 100 }, // 부하 증가
        { duration: "10s", target: 200 }, // 과부하 구간(여기서 429가 늘어야 정상)
        { duration: "10s", target: 0 }, // 쿨다운
      ],
    },
  },
  thresholds: {
    // 서버가 죽지 않고 429로 "안전하게" 거부하는지가 핵심.
    // 5xx(서버 에러)는 거의 없어야 하고, 통과한 요청의 p95는 상한 안이어야 한다.
    "http_req_failed{expected_response:true}": ["rate<0.05"],
    http_req_duration: ["p(95)<20000"], // mock 지연 기준. 실제 Gemini면 조정
  },
};

const QUESTIONS = Array.from({ length: 20 }, (_, i) => `k6 부하 질문 ${i}`);

export default function () {
  // VU/반복마다 다른 IP → Rate Limiter 입장에선 "서로 다른 사용자"
  const ip = `10.1.${__VU % 256}.${(__ITER % 250) + 1}`;
  const res = http.post(
    "http://localhost:3001/api/search",
    JSON.stringify({ question: QUESTIONS[__ITER % QUESTIONS.length] }),
    {
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      // 429는 "서버가 정상적으로 거부한 것"이므로 실패가 아니라 기대된 응답으로 표시
      responseCallback: http.expectedStatuses(200, 429),
    }
  );
  check(res, {
    "정상 처리(200) 또는 안전한 거부(429)": (r) => r.status === 200 || r.status === 429,
    "서버 에러(5xx) 아님": (r) => r.status < 500,
  });
}
