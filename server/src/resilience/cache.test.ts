import { test } from "node:test";
import assert from "node:assert/strict";
import { LruTtlCache } from "./cache.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("넣은 값을 그대로 돌려주고, 없는 키는 undefined", () => {
  const cache = new LruTtlCache<number>(10, 1000);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("없음"), undefined);
});

test("TTL이 지나면 만료된다", async () => {
  const cache = new LruTtlCache<string>(10, 30); // 30ms 수명
  cache.set("k", "v");
  assert.equal(cache.get("k"), "v");
  await sleep(50);
  assert.equal(cache.get("k"), undefined); // 만료
});

test("maxSize를 넘으면 가장 오래된 것부터 버린다(LRU)", () => {
  const cache = new LruTtlCache<number>(2, 10000);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3); // a가 밀려난다
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
});

test("최근에 쓴 키는 축출 대상에서 밀려난다", () => {
  const cache = new LruTtlCache<number>(2, 10000);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a"); // a를 최근 사용으로 갱신
  cache.set("c", 3); // 이제 가장 오래된 건 b
  assert.equal(cache.get("a"), 1); // 살아있음
  assert.equal(cache.get("b"), undefined); // b가 밀려남
});

test("hitRate 통계가 히트/미스를 반영한다", () => {
  const cache = new LruTtlCache<number>(10, 10000);
  cache.set("a", 1);
  cache.get("a"); // hit
  cache.get("a"); // hit
  cache.get("x"); // miss
  const s = cache.stats;
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.hitRate, Number((2 / 3).toFixed(3)));
});
