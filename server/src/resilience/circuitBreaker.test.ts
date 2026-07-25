import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = () => Promise.reject(Object.assign(new Error("실패"), { status: 503 }));
const ok = () => Promise.resolve("성공");

test("실패가 임계치에 닿으면 회로가 열린다", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetMs: 1000, label: "t" });
  for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
  assert.equal(cb.snapshot.state, "open");
});

test("열린 회로는 실제 호출 없이 즉시 실패시킨다(빠른 실패)", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetMs: 1000, label: "t" });
  await cb.run(fail).catch(() => {}); // 임계치 1 → 바로 open

  let actuallyCalled = false;
  await assert.rejects(
    cb.run(async () => {
      actuallyCalled = true;
      return "호출됨";
    }),
    CircuitOpenError
  );
  assert.equal(actuallyCalled, false); // 함수가 실행조차 안 됐다
});

test("resetMs가 지나면 half-open으로 시험 호출, 성공하면 닫힌다", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetMs: 30, label: "t" });
  await cb.run(fail).catch(() => {}); // open
  assert.equal(cb.snapshot.state, "open");

  await sleep(40); // 식힘
  const result = await cb.run(ok); // 시험 호출 성공
  assert.equal(result, "성공");
  assert.equal(cb.snapshot.state, "closed"); // 정상 복구
});

test("half-open에서 다시 실패하면 회로가 도로 열린다", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetMs: 30, label: "t" });
  await cb.run(fail).catch(() => {}); // open
  await sleep(40); // half-open 진입 준비
  await cb.run(fail).catch(() => {}); // 시험 호출 실패
  assert.equal(cb.snapshot.state, "open"); // 도로 열림
});

test("성공하면 실패 카운트가 초기화된다", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetMs: 1000, label: "t" });
  await cb.run(fail).catch(() => {});
  await cb.run(fail).catch(() => {}); // 실패 2회
  await cb.run(ok); // 성공 → 카운트 리셋
  assert.equal(cb.snapshot.failures, 0);
  assert.equal(cb.snapshot.state, "closed");
});
