import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeConfig, patchConfig } from "./runtimeConfig.js";
import { RateLimiter } from "./resilience/rateLimiter.js";

// 관리 엔드포인트는 기본적으로 열려 있다(server.ts). 그래서 여기로 들어오는 값은
// "잘못 보낼 수도 있는 값"이 아니라 "누구나 아무거나 보낼 수 있는 값"이다.
// 숫자가 아닌 값이 통과하면 rateLimitCapacity가 NaN이 되고, TokenBucket의 tokens가
// NaN이 되어 tryConsume()의 `NaN >= 1`이 영원히 false — 모든 IP가 429로 막힌다.

test("숫자로 못 읽는 값은 무시하고 기존 설정을 지킨다", () => {
  patchConfig({ rateLimitCapacity: 7, rateLimitRefillPerSec: 3 });
  assert.equal(runtimeConfig.rateLimitCapacity, 7);

  for (const bad of ["abc", "", null, undefined, {}, [], true, NaN, Infinity]) {
    patchConfig({ rateLimitCapacity: bad, rateLimitRefillPerSec: bad, mockFailRate: bad });
    assert.equal(runtimeConfig.rateLimitCapacity, 7, `${JSON.stringify(bad)}이(가) 통과했다`);
    assert.equal(runtimeConfig.rateLimitRefillPerSec, 3);
    assert.ok(Number.isFinite(runtimeConfig.mockFailRate));
  }
});

test("망가진 설정을 밀어 넣어도 rate limiter가 모두를 막아버리지 않는다", () => {
  patchConfig({ rateLimitCapacity: 5, rateLimitRefillPerSec: 2 });
  patchConfig({ rateLimitCapacity: "다섯개" }); // 예전엔 여기서 서비스가 통째로 멈췄다

  const limiter = new RateLimiter(
    () => runtimeConfig.rateLimitCapacity,
    () => runtimeConfig.rateLimitRefillPerSec
  );
  assert.equal(limiter.allow("1.1.1.1"), true);
  assert.equal(limiter.allow("2.2.2.2"), true);
});

test("유효한 값은 안전 범위 안으로 접어서 반영한다", () => {
  patchConfig({ mockFailRate: 5, rateLimitCapacity: 999999, rateLimitRefillPerSec: 0 });
  assert.equal(runtimeConfig.mockFailRate, 1); // 0~1
  assert.equal(runtimeConfig.rateLimitCapacity, 10000); // 1~10000
  assert.equal(runtimeConfig.rateLimitRefillPerSec, 0.1); // 하한

  patchConfig({ rateLimitCapacity: "12" }); // 숫자로 읽히는 문자열은 받는다
  assert.equal(runtimeConfig.rateLimitCapacity, 12);
});
