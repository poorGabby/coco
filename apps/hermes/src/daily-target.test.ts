import test from "node:test";
import assert from "node:assert/strict";
import { resolveDailyReportChatId } from "./daily-target.js";

test("scheduled report resolves exactly one configured Feishu chat", () => {
  assert.equal(resolveDailyReportChatId("  oc_abc123  "), "oc_abc123");
});

test("scheduled report fails closed for missing or multiple destinations", () => {
  assert.throws(() => resolveDailyReportChatId(""), /is required/);
  assert.throws(
    () => resolveDailyReportChatId("oc_first,oc_second"),
    /exactly one valid chat ID/,
  );
});
