import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { SearchResult } from "./exa.js";
import { geminiGuard, openaiGuard } from "./guards.js";
import { openMockLlmStream } from "./mockLlm.js";

// Gemini와 OpenAI는 프롬프트는 같고 스트리밍 API 모양만 달라서,
// 둘 다 "텍스트 조각을 내보내는 async generator"로 감싸 통일했다.
// 라우트 쪽은 어느 프로바이더가 붙어 있는지 몰라도 된다.
//
// 재시도/타임아웃/동시성/서킷은 예전엔 이 파일의 withRetry가 재시도만 했지만,
// 지금은 guards.ts의 Guard가 네 겹으로 한 번에 처리한다. 여기선 스트림을 여는
// 호출만 guard.call()로 감싼다. 일단 토큰이 흐르기 시작하면(아래 for await)
// 재시도할 수 없다 — 다시 부르면 이미 화면에 나간 답 위에 중복으로 붙기 때문.

function buildPrompt(question: string, sources: SearchResult[]) {
  const sourceBlock = sources
    .map((s, i) => {
      const date = s.publishedDate ? ` (${s.publishedDate.slice(0, 10)})` : "";
      return `[${i + 1}] ${s.title}${date}\n${s.url}\n${s.text}`;
    })
    .join("\n\n");

  return `당신은 웹 검색 결과를 근거로 답하는 음성 검색 어시스턴트입니다.

규칙:
- 아래 검색 결과만 근거로 답합니다. 검색 결과에 없는 내용은 추측하지 마세요.
- 근거로 쓴 검색 결과 번호를 문장 끝에 [1], [2] 형태로 표시하세요.
- 답변은 음성으로도 재생되므로, 소리 내어 읽었을 때 자연스러운 문장으로 쓰세요.
  굵게(**), 제목(#), 표 같은 마크다운 서식은 쓰지 마세요.
- 한국어로, 서너 문장 정도로 간결하게 답하세요.
- 검색 결과끼리 내용이 다르면 더 최근 날짜 쪽을 우선하고, 언제 기준인지 밝혀주세요.

검색 결과:
${sourceBlock}

질문: ${question}`;
}

async function* streamGemini(prompt: string) {
  // 부하 테스트 모드: 실제 SDK 대신 mock 스트림을 guard로 감싼다(같은 지점에서 개입)
  if (process.env.MOCK_LLM) {
    const stream = await geminiGuard.call(() => openMockLlmStream(false));
    for await (const chunk of stream) {
      if (chunk.text) yield chunk.text;
    }
    return;
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const stream = await geminiGuard.call(() =>
    ai.models.generateContentStream({
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      contents: prompt,
    })
  );
  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}

async function* streamOpenAI(prompt: string) {
  // 키가 없으면 생성자부터 던지므로 실제 쓸 때만 만든다
  const openai = new OpenAI();
  const stream = await openaiGuard.call(() =>
    openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    })
  );
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

export function streamAnswer(question: string, sources: SearchResult[]) {
  const prompt = buildPrompt(question, sources);
  return process.env.LLM_PROVIDER === "openai" ? streamOpenAI(prompt) : streamGemini(prompt);
}

export type GroundedEvent =
  | { kind: "text"; text: string }
  | { kind: "sources"; sources: { title: string; url: string }[] };

// EXA_API_KEY가 없을 때의 검색 경로. Gemini에 내장된 구글 검색(grounding)을
// 켜서 검색과 생성을 한 번의 호출로 처리한다. 어떤 페이지를 참고했는지는
// 스트리밍 중간중간 groundingMetadata로 오기 때문에, 모아뒀다가 마지막에
// sources 이벤트 하나로 내보낸다.
export async function* streamGroundedAnswer(question: string): AsyncGenerator<GroundedEvent> {
  // 부하 테스트 모드: mock 스트림을 guard로 감싸 동일하게 처리한다
  if (process.env.MOCK_LLM) {
    const stream = await geminiGuard.call(() => openMockLlmStream(true));
    const seen = new Map<string, { title: string; url: string }>();
    for await (const chunk of stream) {
      if (chunk.text) yield { kind: "text", text: chunk.text };
      const grounding = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
      for (const c of grounding ?? []) {
        if (c.web?.uri && !seen.has(c.web.uri)) {
          seen.set(c.web.uri, { title: c.web.title || c.web.uri, url: c.web.uri });
        }
      }
    }
    yield { kind: "sources", sources: [...seen.values()] };
    return;
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const prompt = `당신은 웹 검색으로 최신 정보를 확인해서 답하는 음성 검색 어시스턴트입니다.

규칙:
- 구글 검색으로 확인한 내용만 근거로 답하세요. 확실하지 않으면 모른다고 하세요.
- 답변은 음성으로도 재생되므로, 소리 내어 읽었을 때 자연스러운 문장으로 쓰세요.
  굵게(**), 제목(#), 표 같은 마크다운 서식은 쓰지 마세요.
- 한국어로, 서너 문장 정도로 간결하게 답하세요.

질문: ${question}`;

  const stream = await geminiGuard.call(() =>
    ai.models.generateContentStream({
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    })
  );

  const seen = new Map<string, { title: string; url: string }>();
  for await (const chunk of stream) {
    if (chunk.text) yield { kind: "text", text: chunk.text };
    const grounding = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
    for (const c of grounding ?? []) {
      if (c.web?.uri && !seen.has(c.web.uri)) {
        seen.set(c.web.uri, { title: c.web.title || c.web.uri, url: c.web.uri });
      }
    }
  }
  yield { kind: "sources", sources: [...seen.values()] };
}
