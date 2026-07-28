import { test } from "node:test";
import assert from "node:assert/strict";
import { Guard } from "./guard.js";
import { SemaphoreResetError } from "./semaphore.js";
import { CircuitOpenError } from "./circuitBreaker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 회귀 테스트: 대기열이 쌓인 상태에서 reset()을 부르면, 대기자 거절이
// 마이크로태스크로 "서킷 초기화 이후에" 도착한다. 이 거절을 실패로 세면
// 초기화 직후 서킷이 도로 열리는 버그가 된다(실제로 있었던 버그).
test("대기열이 쌓인 채 reset()해도 서킷은 closed로 남는다", async () => {
  const guard = new Guard({
    label: "test",
    maxConcurrent: 1,
    timeoutMs: 60000,
    failureThreshold: 3,
    resetMs: 60000,
    retryDelays: [],
  });

  // 유일한 슬롯을 점유해 둔다
  let releaseBlocker!: () => void;
  const blocker = guard.call(
    () => new Promise<void>((r) => (releaseBlocker = r))
  );

  // failureThreshold(3)를 넘는 대기자를 큐에 세운다
  const waiters = Array.from({ length: 5 }, () =>
    guard.call(() => Promise.resolve("ok")).catch((e) => e)
  );
  await sleep(10);
  assert.equal(guard.metrics.queued, 5);

  guard.reset();
  await sleep(20); // 거절 마이크로태스크가 전부 소화될 시간

  // 대기자들은 SemaphoreResetError로 취소되고
  const results = await Promise.all(waiters);
  for (const r of results) assert.ok(r instanceof SemaphoreResetError);
  // 서킷은 그 거절들을 실패로 세지 않아 closed여야 한다
  assert.equal(guard.metrics.circuit.state, "closed");
  assert.equal(guard.metrics.circuit.failures, 0);

  // 슬롯이 풀리면 새 호출도 정상 통과한다
  releaseBlocker();
  await blocker;
  assert.equal(await guard.call(() => Promise.resolve("fresh")), "fresh");
});

test("일시 오류(503)는 재시도로 흡수되고 서킷은 닫혀 있다", async () => {
  const guard = new Guard({
    label: "test",
    maxConcurrent: 2,
    timeoutMs: 1000,
    failureThreshold: 3,
    resetMs: 60000,
    retryDelays: [5], // 1회 재시도
  });

  let calls = 0;
  const result = await guard.call(async () => {
    calls++;
    if (calls === 1) {
      const err = new Error("일시 오류") as Error & { status: number };
      err.status = 503;
      throw err;
    }
    return "복구됨";
  });

  assert.equal(result, "복구됨");
  assert.equal(calls, 2); // 실패 1번 + 재시도 성공 1번
  assert.equal(guard.metrics.circuit.state, "closed");
});

test("진짜 실패가 쌓이면 회로가 열리고 즉시 실패한다", async () => {
  const guard = new Guard({
    label: "test",
    maxConcurrent: 2,
    timeoutMs: 1000,
    failureThreshold: 2,
    resetMs: 60000,
    retryDelays: [],
  });

  let calls = 0;
  const failing = () => {
    calls++;
    return Promise.reject(new Error("죽은 API"));
  };
  await assert.rejects(guard.call(failing));
  await assert.rejects(guard.call(failing)); // 임계치(2) 도달 → open

  // 열린 뒤에는 fn을 부르지도 않고 즉시 CircuitOpenError
  await assert.rejects(guard.call(failing), CircuitOpenError);
  assert.equal(calls, 2);
  assert.equal(guard.metrics.circuit.state, "open");

  // reset()이 회로를 닫아 다시 통과시킨다
  guard.reset();
  assert.equal(await guard.call(() => Promise.resolve("복구")), "복구");
});
