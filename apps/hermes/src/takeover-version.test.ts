import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTakeoverVersionQuery,
  TAKEOVER_VERSION_REPLY,
} from "./takeover-version.js";

test("接管版本口令返回固定验收标记", () => {
  assert.equal(TAKEOVER_VERSION_REPLY, "CoCo takeover-20260803");
  assert.equal(isTakeoverVersionQuery("接管版本"), true);
  assert.equal(isTakeoverVersionQuery("  接管版本？  "), true);
  assert.equal(isTakeoverVersionQuery("接管版本?"), true);
});

test("普通版本问题不会误触发接管口令", () => {
  assert.equal(isTakeoverVersionQuery("现在是什么版本"), false);
  assert.equal(isTakeoverVersionQuery("怎么修改接管版本"), false);
  assert.equal(isTakeoverVersionQuery("日报"), false);
});
