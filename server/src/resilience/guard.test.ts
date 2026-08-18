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

// --- 스트리밍 호출(callStream) ---
// call()로 스트림을 "여는 것"만 감쌌을 때 조용히 새 나가던 두 겹을 확인한다.

async function* ticker(n: number, gapMs: number) {
  for (let i = 0; i < n; i++) {
    yield i;
    await sleep(gapMs);
  }
}

test("callStream은 스트림을 다 쓸 때까지 동시성 자리를 붙들고 있는다", async () => {
  const g = new Guard({ label: "s", maxConcurrent: 2, timeoutMs: 5000, failureThreshold: 5, resetMs: 1000, retryDelays: [] });

  const peaks: number[] = [];
  const consume = async () => {
    for await (const _ of g.callStream(async () => ticker(5, 10))) {
      peaks.push(g.metrics.inUse); // 토큰이 흐르는 "도중"의 동시 실행 수
    }
  };
  await Promise.all([consume(), consume(), consume(), consume()]);

  // 자리를 열자마자 반납했다면 스트리밍 중 inUse가 0으로 보이고 4개가 함께 흘렀을 것이다
  assert.ok(peaks.every((n) => n >= 1 && n <= 2), `동시 실행이 상한을 넘음: ${[...new Set(peaks)]}`);
  assert.equal(g.metrics.inUse, 0); // 다 끝나면 전부 반납된다
});

test("스트림 도중의 실패도 서킷이 실패로 센다(열리는 순간이 헤더 뒤여도)", async () => {
  const g = new Guard({ label: "s", maxConcurrent: 4, timeoutMs: 5000, failureThreshold: 3, resetMs: 1000, retryDelays: [] });

  // 스트림은 정상적으로 열리고 토큰도 조금 흐르다가, 본문 도중에 죽는 장애.
  // 실제 SDK가 이렇게 실패한다(200 헤더 → 본문에서 에러 청크).
  const dyingStream = async () =>
    (async function* () {
      yield "안";
      throw Object.assign(new Error("본문에서 죽음"), { status: 503 });
    })();

  for (let i = 0; i < 3; i++) {
    await assert.rejects(async () => {
      for await (const _ of g.callStream(dyingStream)) { /* 소비만 한다 */ }
    });
  }

  assert.equal(g.metrics.circuit.state, "open"); // 예전엔 영원히 closed였다
});

test("소비자가 중간에 그만둬도 자리는 반납되고 서킷은 닫힌 채로 남는다", async () => {
  const g = new Guard({ label: "s", maxConcurrent: 2, timeoutMs: 5000, failureThreshold: 2, resetMs: 1000, retryDelays: [] });

  // 사용자가 탭을 닫아 라우트가 for await를 break 하는 상황
  for await (const _ of g.callStream(async () => ticker(10, 5))) break;

  assert.equal(g.metrics.inUse, 0); // 자리 누수 없음
  assert.equal(g.metrics.queued, 0);
  assert.equal(g.metrics.circuit.state, "closed"); // 우리가 그만둔 것이지 외부 실패가 아니다
});
