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

test("all formal core metrics are confirmed against fixed Chart IDs", () => {
  for (const definition of Object.values(BUSINESS_METRIC_DEFINITIONS)) {
    assert.equal(definition.status, "confirmed");
    assert.ok(definition.chartId);
    assert.match(definition.metricVersion, new RegExp(definition.chartId!));
  }
});

test("confirmed Chart-backed metrics pass the definition gate", () => {
  for (const metric of Object.keys(BUSINESS_METRIC_DEFINITIONS)) {
    assert.doesNotThrow(() => assertBusinessMetricConfirmed(metric as keyof typeof BUSINESS_METRIC_DEFINITIONS));
  }
});

test("approved screenshot definitions are recorded without Stripe substitution", () => {
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.chartId, "ilhu9t17");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.title, "Daily Active Users (DAU) — Calendar Day");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.chartDefinition.rollingAverageDays, null);
  assert.equal(BUSINESS_METRIC_DEFINITIONS.DAU.chartDefinition.interval, "daily");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartId, "1n0bfs5k");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.title, "New Users (Daily)");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartDefinition.measure, "uniques");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartDefinition.segment, "None");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.New_Users.chartDefinition.interval, "daily");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue.chartId, "qycqvc95");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue.title, "Daily Revenue");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue.chartDefinition.unitPriceUsd, 9.99);
  assert.match(JSON.stringify(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue), /purchase_completed/);
  assert.doesNotMatch(JSON.stringify(BUSINESS_METRIC_DEFINITIONS.Daily_Revenue), /Stripe/i);
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Companion_Retention.title, "Companion Retention");
  assert.equal(BUSINESS_METRIC_DEFINITIONS.Purchaser_Companion_Retention.title, "Purchaser Companion Retention");
});

test("registry exposes all Chart-backed standard functions", () => {
  const registry = buildToolRegistry(minimalEnv);
  assert.equal(typeof registry.fetch_amplitude_metric, "function");
  assert.equal(typeof registry.fetch_purchase_users, "function");
  assert.equal(typeof registry.fetch_daily_revenue, "function");
  assert.equal(typeof registry.fetch_retention_metric, "function");
});
