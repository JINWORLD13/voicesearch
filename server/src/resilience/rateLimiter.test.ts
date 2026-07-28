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

test("런타임 설정 변경이 이미 버킷을 가진 key에도 즉시 반영된다", () => {
  // 대시보드 슬라이더가 바꾸는 상황. 버킷은 생성 시점 설정을 물고 있으므로,
  // 설정이 달라지면 기존 key의 버킷을 새로 만들어 즉시 적용돼야 한다.
  let capacity = 2;
  const limiter = new RateLimiter(
    () => capacity,
    () => 0.001 // 회복 거의 없음
  );
  assert.equal(limiter.allow("A"), true);
  assert.equal(limiter.allow("A"), true);
  assert.equal(limiter.allow("A"), false); // 옛 용량(2) 소진

  capacity = 5; // 슬라이더로 용량을 올림
  // 새 설정의 버킷(가득 참)으로 갈아타서 다시 허용돼야 한다
  assert.equal(limiter.allow("A"), true);

  capacity = 1; // 내리면 내린 대로 즉시 적용
  assert.equal(limiter.allow("A"), true); // 새 버킷의 1개
  assert.equal(limiter.allow("A"), false); // 바로 소진
});
