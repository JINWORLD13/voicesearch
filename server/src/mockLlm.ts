// 부하 테스트 전용. 실제 LLM(Gemini)은 무료 등급 rate limit과 비용 때문에
// 초당 수백 요청 같은 부하를 줄 수 없다. 그래서 외부 LLM을 "느리고(2~6초),
// 가끔(기본 15%) 503으로 실패하는" 가짜로 격리한다. 그러면 남는 변수는 내 서버
// 계층(세마포어/서킷/타임아웃/캐시)뿐이라, 그 계층의 회복탄력성만 순수하게 측정된다.
//
// MOCK_LLM 환경변수가 있을 때만 llm.ts가 이걸 쓴다. 프로덕션에선 타지 않는다.
// 실패율/지연은 env로 조절해 여러 시나리오(평온/장애/과부하)를 재현한다.

import { runtimeConfig } from "./runtimeConfig.js";

export type MockChunk = {
  text?: string;
  candidates?: Array<{
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri: string; title: string } }> };
  }>;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// 스트림을 여는 시점에 지연 + 확률적 실패를 준다. 값을 runtimeConfig에서 읽으므로
// 대시보드가 실패율/지연을 바꾸면 다음 요청부터 즉시 반영된다("외부 AI 죽이기" 버튼).
// 실제 generateContentStream도 첫 응답까지 기다렸다 실패할 수 있으므로, 이렇게 해야
// guard의 타임아웃/재시도/서킷이 실제와 똑같은 지점에서 개입한다.
export async function openMockLlmStream(withGrounding: boolean): Promise<AsyncGenerator<MockChunk>> {
  const { mockFailRate, mockMinMs, mockMaxMs } = runtimeConfig;
  const latency = mockMinMs + Math.random() * Math.max(0, mockMaxMs - mockMinMs);
  await sleep(latency);

  if (Math.random() < mockFailRate) {
    // status를 붙여야 guard가 재시도/서킷 대상(일시적 오류)으로 인식한다
    const err = new Error("mock LLM 503") as Error & { status: number };
    err.status = 503;
    throw err;
  }

  return (async function* () {
    const words = "이것은 부하 테스트용 가짜 답변입니다 외부 API를 격리해 서버 계층만 측정합니다".split(" ");
    for (const w of words) {
      yield { text: w + " " };
      await sleep(15); // 토큰이 조금씩 흐르는 느낌
    }
    if (withGrounding) {
      yield {
        candidates: [
          { groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/mock", title: "mock.source" } }] } },
        ],
      };
    }
  })();
}
