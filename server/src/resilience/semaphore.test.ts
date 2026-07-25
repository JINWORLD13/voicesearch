import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "./semaphore.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("동시에 max개까지만 실행되고 나머지는 대기한다", async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let maxObserved = 0;

  const task = () =>
    sem.run(async () => {
      running++;
      maxObserved = Math.max(maxObserved, running);
      await sleep(20);
      running--;
    });

  // 5개를 동시에 던져도 실행 중은 항상 2개 이하여야 한다
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(maxObserved, 2);
  assert.equal(running, 0);
});

test("inUse와 queued가 현재 상태를 반영한다", async () => {
  const sem = new Semaphore(1);
  let release!: () => void;
  const blocker = new Promise<void>((r) => (release = r));

  const first = sem.run(async () => {
    await blocker; // 자리를 붙잡고 놓지 않는다
  });
  await sleep(5);
  assert.equal(sem.inUse, 1); // 첫 작업이 유일한 자리를 차지

  const second = sem.run(async () => {});
  await sleep(5);
  assert.equal(sem.queued, 1); // 두 번째는 줄을 선다

  release();
  await Promise.all([first, second]);
  assert.equal(sem.inUse, 0);
  assert.equal(sem.queued, 0);
});

test("한 작업이 던져도 자리는 반납된다", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => {
    throw new Error("의도된 실패");
  }));
  // 실패해도 자리가 새지 않아야 다음 작업이 진행된다
  let ran = false;
  await sem.run(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
