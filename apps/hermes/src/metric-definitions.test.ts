import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "./env.js";
import {
  assertBusinessMetricConfirmed,
  BUSINESS_METRIC_DEFINITIONS,
} from "./metric-definitions.js";
import { buildToolRegistry } from "./agent/tools.js";

const minimalEnv = {
  amplitudeApiKey: "test",
  amplitudeSecretKey: "test",
  stripeApiKey: "",
} as Env;

test("all formal core metrics are confirmed against their declared source", () => {
  for (const [metric, definition] of Object.entries(BUSINESS_METRIC_DEFINITIONS)) {
    assert.equal(definition.status, "confirmed");
    if (metric === "Daily_Revenue") {
      assert.equal(definition.chartId, null);
      assert.match(definition.metricVersion, /stripe/);
    } else {
      assert.ok(definition.chartId);
      assert.match(definition.metricVersion, new RegExp(definition.chartId!));
    }
  }
});

test("confirmed Chart-backed metrics pass the definition gate", () => {
  for (const metric of Object.keys(BUSINESS_METRIC_DEFINITIONS)) {
    assert.doesNotThrow(() => assertBusinessMetricConfirmed(metric as keyof typeof BUSINESS_METRIC_DEFINITIONS));
  }
});

test("Amplitude behavior metrics and Stripe revenue definitions are recorded separately", () => {
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.chartId, "ilhu9t17");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.title, "Daily Active Users (DAU) — Calendar Day");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.chartDefinition.rollingAverageDays, null);
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.chartDefinition.interval, "daily");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartId, "odptyaey");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.title, "New Users (Daily)");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartDefinition.measure, "uniques");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartDefinition.segment, "All Users");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartDefinition.interval, "daily");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue.chartId, null);
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue.title, "Daily Revenue");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue.chartDefinition.source, "Stripe Charges API");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue.chartDefinition.formula, "sum(amount - amount_refunded)");
  assert.match(JSON.stringify(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue), /Stripe/i);
  assert.doesNotMatch(JSON.stringify(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue), /purchase_completed|xqmzi8cs/);
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_User_Retention.chartId, "lthx47q8");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_User_Retention.title, "New User Retention");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_User_Retention.chartDefinition.startEvent, "_new");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_User_Retention.chartDefinition.returnEvent, "companion_alive_daily");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_User_Retention.chartDefinition.retentionMethod, "N-day");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_User_Retention.chartDefinition.interval, "daily");
  assert.deepEqual(BUSINESS_METRIC_DEFINITIONS.New_User_Retention.chartDefinition.days, [1, 3, 7]);
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Purchaser_Companion_Retention.title, "Purchaser Companion Retention");
});

test("registry exposes Amplitude behavior tools and Stripe revenue", () => {
  const registry = buildToolRegistry(minimalEnv);
  assert.equal(typeof registry.fetch_amplitude_metric, "function");
  assert.equal(typeof registry.fetch_purchase_users, "function");
  assert.equal(typeof registry.fetch_daily_revenue, "function");
  assert.equal(typeof registry.fetch_retention_metric, "function");
});
