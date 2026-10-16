import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Env } from "./env.js";
import { lookupSubscription } from "./subscription.js";
import { createCocoMcpServer } from "./coco-mcp.js";
import { buildToolRegistry, getAgentToolDeclarations } from "./agent/tools.js";

test("Go IAM uses metadata identity separately from application auth and never falls back on failure", async (t) => {
  const env = { goBackendOrigin: "https://tag.example", goBackendBearerToken: "business-secret",
    goBackendIamAudience: "https://service.run.app" } as Env;
  let metadataStatus = 200;
  let token = "header.payload.signature";
  let backendCalls = 0;
  let metadataCalls = 0;
  let metadataSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "GET");
    if (url.startsWith("http://metadata.google.internal/")) {
      metadataCalls++;
      assert.equal(new URL(url).searchParams.get("audience"), env.goBackendIamAudience);
      assert.equal(headers.get("Metadata-Flavor"), "Google");
      assert.equal(headers.get("Authorization"), null);
      metadataSignal = options.signal;
      return new Response(token, { status: metadataStatus });
    }
    backendCalls++;
    assert.equal(url, "https://tag.example/api/admin/v1/users/123");
    assert.equal(headers.get("Authorization"), "Bearer business-secret");
    assert.equal(headers.get("X-Serverless-Authorization"), "Bearer header.payload.signature");
    assert.equal(options.signal, metadataSignal);
    return Response.json({ code: 10004, data: null });
  });
  assert.equal((await lookupSubscription(env, { goUserId: "123" })).found, false);
  metadataStatus = 403;
  await assert.rejects(() => lookupSubscription(env, { goUserId: "123" }), /request failed/);
  metadataStatus = 200;
  for (token of ["", "private failure text", "a.b.c\r\nInjected: x"]) {
    await assert.rejects(() => lookupSubscription(env, { goUserId: "123" }), /request failed/);
  }
  assert.equal(backendCalls, 1);
  const before = metadataCalls;
  for (const audience of ["http://service.run.app", "https://u:p@service.run.app", "https://service.run.app/path"]) {
    await assert.rejects(() => lookupSubscription({ ...env, goBackendIamAudience: audience }, { goUserId: "123" }), /request failed/);
  }
  assert.equal(metadataCalls, before);
});

test("Go subscription lookup preserves uint64 identity, access states and fail-closed errors", async (t) => {
  const env = { goBackendOrigin: "https://backend.example", goBackendBearerToken: "test-only" } as Env;
  const id = "9007199254740993";
  let payload = "";
  let httpStatus = 200;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, `https://backend.example/api/admin/v1/users/${id}`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer test-only");
    return new Response(payload, { status: httpStatus });
  });
  const body = (status: string, expiry: string | null) => JSON.stringify({
    code: 0, data: { id: "RAW_ID", subscription_status: status, subscription_expires_at: expiry,
      plan_tier: "live", updated_at: "2026-09-01T00:00:00Z", email: "private@example.com", firebase_uid: "private-uid" },
  }).replace('"RAW_ID"', id);
  for (const [status, expiry, access] of [
    ["active", "2099-01-01T00:00:00Z", true],
    ["cancelled", "2099-01-01T00:00:00Z", true],
    ["active", "2000-01-01T00:00:00Z", false],
    ["cancelled", "2000-01-01T00:00:00Z", false],
    ["expired", null, false], ["none", null, false],
    ["trialing", null, true], ["in_grace_period", null, true],
    ["in_billing_retry", null, true], ["paused", null, false],
    ["incomplete", null, false], ["unknown", null, null], ["future-status", null, null],
  ] as const) {
    payload = body(status, expiry);
    const result = await lookupSubscription(env, { goUserId: id });
    assert.equal(result.goUserId, id);
    assert.equal(result.hasAccess, access, status);
    assert.doesNotMatch(JSON.stringify(result), /private@example|private-uid|test-only/);
  }
  const priorCalls = calls;
  for (const invalid of [9007199254740992, "0", "18446744073709551616", "1/../../users", "11111111-1111-4111-8111-111111111111"]) {
    await assert.rejects(() => lookupSubscription(env, { goUserId: invalid }));
  }
  await assert.rejects(() => lookupSubscription({} as Env, { goUserId: id }), /not configured/);
  for (const origin of ["http://backend.example", "https://a:b@backend.example", "https://backend.example/path"]) {
    await assert.rejects(() => lookupSubscription({ ...env, goBackendOrigin: origin }, { goUserId: id }));
  }
  assert.equal(calls, priorCalls);
  for (const invalidBody of [body("active", "not-a-date"), body("active", null).replace(id, "12"), '{"code":0,"data":{}}', "invalid"]) {
    payload = invalidBody;
    await assert.rejects(() => lookupSubscription(env, { goUserId: id }));
  }
  payload = '{"code":10004,"data":null}';
  assert.equal((await lookupSubscription(env, { goUserId: id })).hasAccess, null);
  payload = '{"code":10001,"data":null,"message":"SECRET upstream error"}';
  await assert.rejects(() => lookupSubscription(env, { goUserId: id }), /^Error: Go backend rejected subscription query \(code 10001\)$/);
  httpStatus = 401;
  await assert.rejects(() => lookupSubscription(env, { goUserId: id }), /request failed/);
  httpStatus = 200;
  payload = body("active", null);

  for (const configuredEnv of [{} as Env, env]) {
    const enabled = configuredEnv === env;
    assert.equal("lookup_go_subscription" in buildToolRegistry(configuredEnv), enabled);
    assert.equal(getAgentToolDeclarations(configuredEnv).some(t => t.name === "lookup_go_subscription"), enabled);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createCocoMcpServer(configuredEnv);
    const client = new Client({ name: "subscription-test", version: "1" });
    try {
      await server.connect(a);
      await client.connect(b);
      assert.equal((await client.listTools()).tools.some(t => t.name === "lookup_go_subscription"), enabled);
      if (enabled) {
        const result = await client.callTool({ name: "lookup_go_subscription", arguments: { goUserId: id } });
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result.content), /9007199254740993/);
        payload = '{"code":10001,"data":null}';
        assert.equal((await client.callTool({ name: "lookup_go_subscription", arguments: { goUserId: id } })).isError, true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});
