import axios from "axios";
import { exaGuard } from "./guards.js";

export type SearchResult = {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
};

// Exa는 키워드 매칭이 아니라 문장 의미로 찾는 검색이라,
// 음성으로 들어오는 "요즘 전기차 보조금 어떻게 돼?" 같은
// 자연어 질문을 그대로 넘겨도 결과가 잘 나온다.
// 검색 호출은 exaGuard로 감싼다(타임아웃/동시성/재시도/서킷).
export async function searchWeb(query: string): Promise<SearchResult[]> {
  const { data } = await exaGuard.call(() =>
    axios.post(
      "https://api.exa.ai/search",
      {
        query,
        numResults: 5,
        // 본문 전문을 다 받으면 프롬프트가 쓸데없이 커져서 1500자로 자른다
        contents: { text: { maxCharacters: 1500 } },
      },
      {
        headers: { "x-api-key": process.env.EXA_API_KEY },
        timeout: 15000,
      }
    )
  );

  type ExaResult = { title?: string; url: string; text?: string; publishedDate?: string };
  return ((data.results ?? []) as ExaResult[]).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    text: r.text || "",
    publishedDate: r.publishedDate,
  }));
}
