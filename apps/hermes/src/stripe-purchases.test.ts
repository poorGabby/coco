import { test } from "node:test";
import assert from "node:assert/strict";
import { stripePurchaseCounts, stripePurchaseRevenue, type StripePurchaseDay } from "./stripe-purchases.js";

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
  assert.equal(stripePurchaseRevenue(day), 28.94);
});
