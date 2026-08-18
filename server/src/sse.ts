// SSE(Server-Sent Events) 스트림 파싱의 순수 로직만 떼어낸 함수.
// 네트워크는 이벤트 단위로 데이터를 주지 않는다. "data: {"type":"del" 까지만 오고
// 나머지가 다음 조각에 오는 식으로, 이벤트 경계와 무관하게 잘려서 도착한다.
// 그래서 버퍼에 쌓고, 이벤트 구분자인 빈 줄(\n\n)로만 자른다.
// 마지막 조각은 아직 미완성일 수 있으므로 파싱하지 않고 다음 턴을 위해 남긴다.
//
// 순수 함수(입력 → 출력, 부수효과 없음)라 결정론적으로 테스트할 수 있다.
// 실제로 이 프로젝트에서 겪은 "조각 잘림 → JSON.parse 실패" 버그를 이 로직으로 막았다.

export function parseSSEBuffer(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? ""; // 마지막은 미완성일 수 있으니 남긴다
  const events: unknown[] = [];
  for (const part of parts) {
    const line = part.trim();
    if (!line.startsWith("data:")) continue;
    // 깨진 조각 하나로 스트림 전체를 잃지 않는다. 그 조각만 버리고 계속 읽는다.
    try {
      events.push(JSON.parse(line.slice(5)));
    } catch {
      continue;
    }
  }
  return { events, rest };
}
