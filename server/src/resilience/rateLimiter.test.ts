import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket, RateLimiter } from "./rateLimiter.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("버킷은 capacity만큼 즉시 소비되고 그 다음은 거부된다", () => {
  const bucket = new TokenBucket(3, 1); // 용량 3, 초당 1개 회복
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false); // 4번째는 거부(버스트 소진)
});

test("시간이 지나면 토큰이 회복된다", async () => {
  const bucket = new TokenBucket(1, 20); // 용량 1, 초당 20개(=50ms에 1개)
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false); // 소진
  await sleep(80); // 80ms면 1개 이상 회복
  assert.equal(bucket.tryConsume(), true); // 다시 가능
});

test("회복은 capacity를 넘지 않는다", async () => {
  const bucket = new TokenBucket(2, 100); // 빠른 회복
  bucket.tryConsume();
  bucket.tryConsume(); // 소진
  await sleep(100); // 오래 기다려도
  assert.ok(bucket.available <= 2); // 최대 2까지만 참
});

test("사용자(key)별로 버킷이 독립적이다", () => {
  const limiter = new RateLimiter(
    () => 2,
    () => 0.001 // 회복 거의 없음
  );
  // A가 자기 버킷을 다 써도
  assert.equal(limiter.allow("A"), true);
  assert.equal(limiter.allow("A"), true);
  assert.equal(limiter.allow("A"), false); // A는 소진
  // B는 영향 없이 자기 몫을 쓴다
  assert.equal(limiter.allow("B"), true);
  assert.equal(limiter.allow("B"), true);
  assert.equal(limiter.trackedKeys, 2);
});
