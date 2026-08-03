/**
 * Wix Analytics — 通过 Velo HTTP endpoint 拉取。
 *
 * 前提：Wix Dashboard → Dev Mode → Backend → http-functions.js
 * 已部署 velo-uniqueVisitors.js（见项目根目录）。
 */

import type { ChartSnapshot } from "./amplitude.js";
import type { Env } from "./env.js";

export async function fetchWixSnapshot(env: Env): Promise<ChartSnapshot | null> {
  if (!env.wixApiKey || !env.wixSiteUrl) {
    console.log("[wix] WIX_API_KEY or WIX_SITE_URL not configured, skipping");
    return null;
  }

  try {
    const url = `${env.wixSiteUrl.replace(/\/+$/, "")}/_functions/uniqueVisitors`;
    console.log("[wix] calling Velo endpoint:", url);
    const res = await fetch(url, { headers: { "x-api-key": env.wixApiKey } });

    if (res.ok) {
      const data = await res.json();
      console.log("[wix] Velo OK:", JSON.stringify(data).slice(0, 300));
      return data as ChartSnapshot;
    }

    console.log("[wix] Velo HTTP", res.status, await res.text().catch(() => "").then(t => t.slice(0, 200)));
    return makeError(`Velo endpoint returned HTTP ${res.status}`);
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 200) || "unknown";
    console.log("[wix] Velo failed:", msg);
    return makeError(`Wix Velo: ${msg}`);
  }
}

function makeError(msg: string): ChartSnapshot {
  return {
    chartId: "wix-site-data", title: "Wix Site Data", kind: "unknown",
    metricLabel: "N/A", yesterday: null, dayBefore: null,
    yesterdayValue: null, dayBeforeValue: null, changePct: null, error: msg,
  };
}
