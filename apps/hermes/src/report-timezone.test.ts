import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_TIME_ZONE,
  reportDateOfEpochSec,
  reportDateStr,
  reportMidnightUtcSec,
  reportWeekMonday,
} from "./report-timezone.js";

test("report timezone is America/Dawson and stays UTC-7 in winter and summer", () => {
  assert.equal(REPORT_TIME_ZONE, "America/Dawson");
  assert.equal(
    new Date(reportMidnightUtcSec("2026-01-15") * 1000).toISOString(),
    "2026-01-15T07:00:00.000Z",
  );
  assert.equal(
    new Date(reportMidnightUtcSec("2026-07-15") * 1000).toISOString(),
    "2026-07-15T07:00:00.000Z",
  );
});

test("report day and week helpers use Dawson calendar boundaries", () => {
  const beforeMidnight = new Date("2026-09-02T06:59:59Z");
  const atMidnight = new Date("2026-09-02T07:00:00Z");
  assert.equal(reportDateStr(0, beforeMidnight), "2026-09-01");
  assert.equal(reportDateStr(0, atMidnight), "2026-09-02");
  assert.equal(reportDateOfEpochSec(beforeMidnight.getTime() / 1000), "2026-09-01");
  assert.equal(reportDateOfEpochSec(atMidnight.getTime() / 1000), "2026-09-02");
  assert.equal(reportWeekMonday(0, atMidnight), "2026-08-31");
});
