import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSEBuffer } from "./sse.js";

test("완성된 이벤트를 파싱하고 미완성 조각은 남긴다", () => {
  const buffer = `data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c`;
  const { events, rest } = parseSSEBuffer(buffer);
  assert.deepEqual(events, [{ type: "a" }, { type: "b" }]);
  assert.equal(rest, `data: {"type":"c`); // 미완성은 다음 턴으로
});

test("조각이 이어붙어 완성되면 그때 파싱된다(잘림 버그 방지)", () => {
  // 1차 도착: 이벤트가 중간에서 잘림
  let { events, rest } = parseSSEBuffer(`data: {"type":"del`);
  assert.deepEqual(events, []); // 아직 파싱하지 않는다
  assert.equal(rest, `data: {"type":"del`);

  // 2차 도착: 남은 조각에 이어붙이면 완성
  ({ events, rest } = parseSSEBuffer(rest + `ta","text":"안녕"}\n\n`));
  assert.deepEqual(events, [{ type: "delta", text: "안녕" }]);
  assert.equal(rest, "");
});

test("data: 접두사가 없는 줄은 무시한다", () => {
  const { events } = parseSSEBuffer(`: keep-alive\n\ndata: {"type":"x"}\n\n`);
  assert.deepEqual(events, [{ type: "x" }]);
});

test("빈 버퍼는 이벤트 없이 안전하게 처리된다", () => {
  const { events, rest } = parseSSEBuffer("");
  assert.deepEqual(events, []);
  assert.equal(rest, "");
});

test("깨진 조각 하나가 뒤따르는 이벤트까지 삼키지 않는다", () => {
  const { events } = parseSSEBuffer(`data: {"type":"a"}\n\ndata: 이건JSON이아님\n\ndata: {"type":"b"}\n\n`);
  assert.deepEqual(events, [{ type: "a" }, { type: "b" }]);
});
