import type { Env } from "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStripeCharge, type StripeCharge, type StripeDailyRevenue } from "./stripe.js";
import { reportMidnightUtcSec } from "./report-timezone.js";

function dayMap(date = "2026-09-06"): Map<string, StripeDailyRevenue> {
  return new Map([[date, { date, revenue: 0, count: 0, byPrice: {}, refunded: 0 }]]);
}

function charge(overrides: Partial<StripeCharge> = {}): StripeCharge {
  return {
    id: "ch_test",
    amount: 999,
    amount_refunded: 0,
    created: reportMidnightUtcSec("2026-09-06") + 3600,
    status: "succeeded",
    paid: true,
    currency: "usd",
    livemode: true,
    ...overrides,
  };
}

test("Stripe Daily Revenue uses paid live USD charges net of refunds", () => {
  const days = dayMap();
  applyStripeCharge(days, charge({ amount: 999, amount_refunded: 200 }));
  const day = days.get("2026-09-06")!;
  assert.equal(day.revenue, 7.99);
  assert.equal(day.refunded, 2);
  assert.equal(day.count, 1);
  assert.equal(day.byPrice["9.99"], 1);
});

test("Stripe Daily Revenue excludes failed or unpaid charges", () => {
  const days = dayMap();
  applyStripeCharge(days, charge({ status: "failed" }));
  applyStripeCharge(days, charge({ paid: false }));
  assert.deepEqual(days.get("2026-09-06"), {
    date: "2026-09-06", revenue: 0, count: 0, byPrice: {}, refunded: 0,
  });
});

test("Stripe Daily Revenue fails closed for test mode, non-USD and invalid refunds", () => {
  assert.throws(() => applyStripeCharge(dayMap(), charge({ livemode: false })), /test-mode/);
  assert.throws(() => applyStripeCharge(dayMap(), charge({ currency: "eur" })), /USD-only/);
  assert.throws(() => applyStripeCharge(dayMap(), charge({ amount_refunded: 1000 })), /invalid amount/);
});

test("Stripe charge outside the requested Dawson dates is ignored", () => {
  const days = dayMap();
  applyStripeCharge(days, charge({ created: reportMidnightUtcSec("2026-09-07") + 1 }));
  assert.equal(days.get("2026-09-06")?.count, 0);
});

test('Stripe exploration deduplicates across pages, keeps refunds explicit and never treats partial scans as totals', async () => {
  const { exploreStripe } = await import('./stripe-explore.js');
  const env={stripeApiKey:'test-key'} as Env;
  let n=0;
  const charge=(id:string,customer:string|null,refund=0)=>({id,customer,livemode:true,status:'succeeded',paid:true,captured:true,amount_captured:999,amount_refunded:refund});
  const get=async (_key:string,path:string)=>{
    n++; assert(path.startsWith('/v1/charges?'));assert(path.includes('created%5Blt%5D'));
    return {status:200,json:n===1?{data:[charge('ch_a','cus_a'),charge('ch_b',null)],has_more:true}:{data:[charge('ch_c','cus_a'),charge('ch_d','cus_b',999)],has_more:false}};
  };
  const r=await exploreStripe(env,{operation:'paying_users'},get);
  assert.equal(r.uniquePayingCustomers,2);assert.equal(r.uniqueCustomersWithNetPayment,1);assert.equal(r.successfulChargesWithoutCustomer,1);assert.equal(r.pages,2);
  await assert.rejects(exploreStripe(env,{operation:'paying_users',limit:1},get),/does not support/);
  await assert.rejects(exploreStripe(env,{operation:'paying_users'},async()=>({status:200,json:{data:[],has_more:true}})),/cursor/);
  await assert.rejects(exploreStripe(env,{operation:'paying_users'},async()=>({status:403,json:{error:{message:'private'}}})),e=>/403/.test(String(e))&&!String(e).includes('private'));
  const list=await exploreStripe(env,{operation:'list',resource:'subscriptions',customer:'cus_a'},async(_k,p)=>{assert(p.includes('status=all'));return {status:200,json:{data:[{id:'sub_a',client_secret:'secret',nested:{persistent_token:'token'},status:'canceled'}],has_more:false}}});
  assert(!JSON.stringify(list).includes('secret'));assert(!JSON.stringify(list).includes('token'));
  const detail=await exploreStripe(env,{operation:'retrieve',resource:'charges',id:'ch_a'},async()=>({status:200,json:{id:'ch_a',receipt_number:'receipt-1',invoice_number:'invoice-1',payment_method_details:{card:{number:'private-card',last4:'4242'},bank:{account_number:'private-account',routing_number:'private-routing'}}}}));
  assert.equal(detail.data.receipt_number,'receipt-1');assert.equal(detail.data.invoice_number,'invoice-1');
  assert.equal(detail.data.payment_method_details.card.last4,'4242');assert(!JSON.stringify(detail).includes('private-'));
  const invoice=await exploreStripe(env,{operation:'retrieve',resource:'invoices',id:'in_a'},async()=>({status:200,json:{id:'in_a',object:'invoice',number:'INV-1',client_secret:'private-secret'}}));
  assert.equal(invoice.data.number,'INV-1');assert(!JSON.stringify(invoice).includes('private-'));
});

test('Stripe nested lists preserve their parent and cursor, and reject unsupported filters before HTTP', async () => {
  const { exploreStripe } = await import('./stripe-explore.js');
  const env = {stripeApiKey:'key'} as Env;
  const calls:URL[]=[];
  const get=async (_key:string,path:string)=>{calls.push(new URL(path,'https://api.stripe.com'));return {status:200,json:{data:[{id:'li_first'}],has_more:true}}};
  for(const [resource,parent,path] of [
    ['subscription_items',{subscription:'sub_a'},'/v1/subscription_items'],
    ['invoice_lines',{invoice:'in_a'},'/v1/invoices/in_a/lines'],
    ['checkout_line_items',{checkoutSession:'cs_a'},'/v1/checkout/sessions/cs_a/line_items'],
  ] as const){
    const args={operation:'list',resource,...parent,limit:1};
    const first=await exploreStripe(env,args,get);assert.equal(first.nextStartingAfter,'li_first');
    await exploreStripe(env,{...args,startingAfter:first.nextStartingAfter},get);
    assert.equal(calls.at(-1)!.pathname,path);assert.equal(calls.at(-1)!.searchParams.get('starting_after'),'li_first');
    if(resource==='subscription_items')assert.equal(calls.at(-1)!.searchParams.get('subscription'),'sub_a');
    const count=calls.length;
    await assert.rejects(exploreStripe(env,{operation:'list',resource},get),/parent identifier/);
    await assert.rejects(exploreStripe(env,{...args,startDate:'2026-09-01'},get),/does not support/);
    assert.equal(calls.length,count);
  }
  await exploreStripe(env,{operation:'list',resource:'checkout_sessions',customer:'cus_a',paymentIntent:'pi_a',subscription:'sub_a'},get);
  assert.equal(calls.at(-1)!.pathname,'/v1/checkout/sessions');assert.equal(calls.at(-1)!.searchParams.get('subscription'),'sub_a');
  await exploreStripe(env,{operation:'retrieve',resource:'checkout_sessions',id:'cs_a'},async(_key,path)=>{assert.equal(path,'/v1/checkout/sessions/cs_a');return {status:200,json:{id:'cs_a'}}});
  await assert.rejects(exploreStripe(env,{operation:'retrieve',resource:'invoice_lines',id:'il_a'},get),/list only/);
});
