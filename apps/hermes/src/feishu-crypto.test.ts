import assert from "node:assert/strict";
import test from "node:test";
import { secretsEqual, verifyFeishuEventToken } from "./feishu-crypto.js";

test("callback and admin secrets fail closed", () => {
  assert.equal(secretsEqual("Bearer secret", "Bearer secret"), true);
  assert.equal(secretsEqual("Bearer wrong", "Bearer secret"), false);
  assert.equal(secretsEqual(undefined, "Bearer secret"), false);
  assert.equal(verifyFeishuEventToken({ header: { token: "token" } }, "token"), true);
  assert.equal(verifyFeishuEventToken({ token: "token" }, "token"), true);
  assert.equal(verifyFeishuEventToken({ header: { token: "wrong" } }, "token"), false);
  assert.equal(verifyFeishuEventToken({}, "token"), false);
});
