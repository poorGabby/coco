/**
 * Wix Velo Backend — HTTP endpoint: /_functions/uniqueVisitors
 *
 * Copy/paste into Wix Dashboard → Dev Mode → Backend → http-functions.js
 *
 * Uses wix-stores for order count as proxy for traffic, plus wix-data Contacts count.
 * Replace with your actual site's data collection names if different.
 */

import { ok, serverError, forbidden } from 'wix-http-functions';
import wixData from 'wix-data';

const EXPECTED_KEY = "IST.eyJraWQiOiJQb3pIX2FDMiIsImFsZyI6IlJTMjU2In0.eyJkYXRhIjoie1wiaWRcIjpcIjU1ZjM3NjdlLTY5ZDYtNDkwMi04MzdiLWIwODk0NGUzNjY0MlwiLFwiaWRlbnRpdHlcIjp7XCJ0eXBlXCI6XCJhcHBsaWNhdGlvblwiLFwiaWRcIjpcIjNiNWI1NzdlLWIwMzctNDIwZi05OTJkLTdlYjhiZTljZWRmZFwifSxcInRlbmFudFwiOntcInR5cGVcIjpcImFjY291bnRcIixcImlkXCI6XCIzMmRhMTRhZS1jOGZhLTRlZDgtYmI3Mi1iYzBiMWNiYzNhMDJcIn19IiwiaWF0IjoxNzgyNzI5NDk2fQ.NKUsoaAdbw6UaCVh742M9o102fvQ5JAmsL1pAV0aPT_NZ7XVKAOp6ZURNQnGs7fE_SCqTQfqhHb5KBlO3uGx-Inx_oS7rW5lE410uDNjeHJAhAFagHMs7X39BRCiCK2EERdUJsrxYJQ5efL9vNBxNGWspVPvK4DoUvPEbFn4EM32PgtPZRqPeKe1IdVT7UF9EL2KyWZjdyFMw5CeAYEUUzakh0AR7-C7aZkdtrbSMZgCsqgrkoxoeOrYLqBkXZTCitCoKv7bujnSLFs4g3NdFstVT0odjSmRG2EwYgCmsx-YAOl19uo64qG-QQQyogDo5iVA3Mp0On2NqdAAKBuXsg";

export async function get_uniqueVisitors(request) {
  if (request.headers['x-api-key'] !== EXPECTED_KEY) {
    return forbidden({ body: { error: 'Forbidden' } });
  }

  try {
    const yesterday = shanghaiDate(-1);
    const dayBefore = shanghaiDate(-2);
    const yStart = new Date(yesterday + 'T00:00:00+08:00');
    const yEnd = new Date(yesterday + 'T23:59:59+08:00');
    const dStart = new Date(dayBefore + 'T00:00:00+08:00');
    const dEnd = new Date(dayBefore + 'T23:59:59+08:00');

    // ---- Approach 1: wix-stores orders as traffic proxy ----
    let yVal = null;
    let dVal = null;

    try {
      const { currentCart, getOrder } = await import('wix-stores-backend');
    } catch (_) {
      // wix-stores not available
    }

    // ---- Approach 2: Count from Wix Contacts created per day ----
    try {
      const yResult = await wixData.query('Contacts/Contacts')
        .ge('_createdDate', yStart)
        .lt('_createdDate', yEnd)
        .count()
        .find({ suppressAuth: false });
      yVal = yResult ? yResult.totalCount : 0;

      const dResult = await wixData.query('Contacts/Contacts')
        .ge('_createdDate', dStart)
        .lt('_createdDate', dEnd)
        .count()
        .find({ suppressAuth: false });
      dVal = dResult ? dResult.totalCount : 0;
    } catch (e) {
      console.log('[uniqueVisitors] Contacts query failed:', e.message);
    }

    // ---- Approach 3: wix-members Members ----
    if (yVal === null) {
      try {
        const yM = await wixData.query('Members/Members')
          .ge('_createdDate', yStart)
          .lt('_createdDate', yEnd)
          .count()
          .find({ suppressAuth: false });
        yVal = yM ? yM.totalCount : 0;

        const dM = await wixData.query('Members/Members')
          .ge('_createdDate', dStart)
          .lt('_createdDate', dEnd)
          .count()
          .find({ suppressAuth: false });
        dVal = dM ? dM.totalCount : 0;
      } catch (e2) {
        console.log('[uniqueVisitors] Members query failed:', e2.message);
      }
    }

    // ---- Approach 4: Any custom collection ----
    if (yVal === null) {
      try {
        // Try to count from a custom "Visitors" or "PageViews" collection if you have one
        // Replace "Visitors" with your actual collection name
        const collections = await wixData.listCollections();
        console.log('[uniqueVisitors] Available collections:', collections.map(c => c.name).join(', '));

        // Try each promising collection
        for (const name of ['Visitors', 'VisitorLog', 'PageViews', 'SiteTraffic', 'Analytics']) {
          try {
            if (collections.some(c => c.name === name)) {
              const yC = await wixData.query(name)
                .ge('_createdDate', yStart)
                .lt('_createdDate', yEnd)
                .count()
                .find({ suppressAuth: false });
              yVal = yC ? yC.totalCount : 0;

              const dC = await wixData.query(name)
                .ge('_createdDate', dStart)
                .lt('_createdDate', dEnd)
                .count()
                .find({ suppressAuth: false });
              dVal = dC ? dC.totalCount : 0;
              console.log(`[uniqueVisitors] Using ${name}: ${dVal} -> ${yVal}`);
              break;
            }
          } catch (_) {}
        }
      } catch (e3) {
        console.log('[uniqueVisitors] Collection discovery failed:', e3.message);
      }
    }

    if (yVal === null) yVal = 0;
    if (dVal === null) dVal = 0;

    const pct = dVal > 0 ? ((yVal - dVal) / dVal) * 100 : null;

    return ok({
      body: {
        chartId: 'wix-site-visitors',
        title: 'Wix Site Visitors',
        kind: 'timeseries',
        metricLabel: 'Visitors',
        yesterday,
        dayBefore,
        yesterdayValue: yVal,
        dayBeforeValue: dVal,
        changePct: pct,
      },
    });
  } catch (err) {
    console.error('[uniqueVisitors]', err);
    return serverError({ body: { error: err.message || 'unknown' } });
  }
}

function shanghaiDate(offset) {
  const now = new Date();
  const sh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  sh.setDate(sh.getDate() + offset);
  return sh.getFullYear() + '-' +
    String(sh.getMonth() + 1).padStart(2, '0') + '-' +
    String(sh.getDate()).padStart(2, '0');
}
