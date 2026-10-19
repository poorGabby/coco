import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { EventEmitter } from "node:events";
import type { Env } from "./env.js";
import { reportMidnightUtcSec } from "./report-timezone.js";
import { fetchStripePurchaseComparison, STRIPE_PRODUCT_MAPPING, stripePurchaseCounts, type StripePurchaseDay } from "./stripe-purchases.js";

test("Stripe WoW fetches only the two comparison days and retains paid quantities across pages", async (t) => {
  const current = "2026-09-02";
  const previous = "2026-08-26";
  const requests: URL[] = [];
  const price = STRIPE_PRODUCT_MAPPING.pocket;
  t.mock.method(https, "request", ((url: string | URL, _options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      queueMicrotask(() => {
        const isCurrent = parsed.searchParams.get("created[gte]") === String(reportMidnightUtcSec(current));
        const secondPage = parsed.searchParams.has("starting_after");
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = 200;
        callback(response);
        response.emit("data", Buffer.from(JSON.stringify({
          has_more: isCurrent && !secondPage,
          data: [{
            id: secondPage ? "cs_second" : "cs_first",
            payment_status: isCurrent ? "paid" : "unpaid",
            customer: "same-customer",
            line_items: { data: [{ quantity: secondPage ? 2 : 1, price: { id: price.priceId, product: price.productId } }] },
          }],
        })));
        response.emit("end");
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  }) as typeof https.request);

  const days = await fetchStripePurchaseComparison({ stripeApiKey: "test-key" } as Env, current);
  assert.deepEqual([...days.keys()], [previous, current]);
  assert.equal(requests.length, 3, "two days plus the current day's second page");
  assert.deepEqual(new Set(requests.map((url) => url.searchParams.get("created[gte]"))), new Set([
    String(reportMidnightUtcSec(previous)), String(reportMidnightUtcSec(current)),
  ]));
  for (const url of requests) {
    assert.equal(Number(url.searchParams.get("created[lt]")) - Number(url.searchParams.get("created[gte]")), 86400);
  }
  assert.equal(requests.find((url) => url.searchParams.has("starting_after"))?.searchParams.get("starting_after"), "cs_first");
  assert.equal(stripePurchaseCounts(days.get(current)).pocket, 1);
});

test("Treats 对 Pocket/Stash/Big Bag 用户 union 去重", () => {
  const day: StripePurchaseDay = {
    date: "2026-08-19",
    users: {
      secondPet: new Set(),
      pocket: new Set(["u1", "u2"]),
      stash: new Set(["u2", "u3"]),
      bigBag: new Set(["u3", "u4"]),
    },
    quantities: { secondPet: 0, pocket: 2, stash: 3, bigBag: 1 },
  };
  assert.deepEqual(stripePurchaseCounts(day), {
    total: 4,
    secondPet: 0,
    treats: 4,
    pocket: 2,
    stash: 2,
    bigBag: 2,
    secondPetQuantity: 0,
    pocketQuantity: 2,
    stashQuantity: 3,
    bigBagQuantity: 1,
  });
});
