/**
 * GA4 Analytics Data API — Cloud Run metadata server token，多项回退。
 */

import type { ChartSnapshot } from "./amplitude.js";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/analytics.readonly";

// ---- Token ----

let cachedToken: { access_token: string; expiresAt: number } | null = null;

async function getAccessToken(saJson?: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.access_token;
  }

  // Metadata server
  try {
    const res = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    if (res.ok) {
      const d = await res.json() as { access_token?: string; expires_in?: number };
      if (d.access_token) {
        cachedToken = { access_token: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
        console.log("[ga4] token from metadata server");
        return cachedToken.access_token;
      }
    }
  } catch { /* fallback */ }

  // SA JSON JWT
  if (saJson) {
    const key = JSON.parse(saJson) as { client_email?: string; private_key?: string };
    if (key.client_email && key.private_key) {
      const crypto = await import("node:crypto");
      const TOKEN_URL = "https://oauth2.googleapis.com/token";
      const b64u = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const jwt = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({
        iss: key.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly",
        aud: TOKEN_URL, exp: now + 3600, iat: now,
      })}`;
      const sig = crypto.sign("sha256", Buffer.from(jwt), {
        key: key.private_key, padding: crypto.constants.RSA_PKCS1_PADDING,
      });
      const assertion = `${jwt}.${sig.toString("base64url")}`;
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      });
      if (res.ok) {
        const d = await res.json() as { access_token?: string; expires_in?: number };
        if (d.access_token) {
          cachedToken = { access_token: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
          console.log("[ga4] token from SA JWT");
          return cachedToken.access_token;
        }
      }
    }
  }

  throw new Error("No GCP credentials available");
}

// ---- Connectivity diagnostics (one-time) ----

let diagRun = false;
async function runDiagnostics(token: string) {
  if (diagRun) return;
  diagRun = true;

  // 1. DNS resolution
  try {
    const dns = await import("node:dns");
    const { promises: dnsPromises } = dns;
    const v4 = await dnsPromises.resolve4("analyticsdata.googleapis.com").catch(() => []);
    const v6 = await dnsPromises.resolve6("analyticsdata.googleapis.com").catch(() => []);
    console.log("[ga4] DNS: v4=", v4.join(","), "v6=", v6.join(","));
  } catch (e) {
    console.log("[ga4] DNS resolve failed:", (e as Error).message);
  }

  // 2. Simple connectivity test (no auth)
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const t0 = Date.now();
    const res = await fetch("https://analyticsdata.googleapis.com/v1beta/properties", {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("[ga4] connectivity test:", res.status, `${Date.now() - t0}ms`);
  } catch (e) {
    console.log("[ga4] connectivity test failed:", (e as Error).message);
  }

  // 3. Try googleapis.com alternative
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("https://analyticsdata.googleapis.com/v1beta/properties", {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("[ga4] alt host test:", res.status);
  } catch (e) {
    console.log("[ga4] alt host test failed:", (e as Error).message);
  }
}

// ---- Main ----

export async function fetchGa4Snapshot(saJson: string, propertyId: string): Promise<ChartSnapshot | null> {
  if (!propertyId) {
    console.log("[ga4] GA4_PROPERTY_ID not configured, skipping");
    return null;
  }

  const yesterday = shanghaiDate(-1);
  const dayBefore = shanghaiDate(-2);

  try {
    const token = await getAccessToken(saJson || undefined);
    await runDiagnostics(token);

    const body = { dateRanges: [{ startDate: dayBefore, endDate: yesterday }], dimensions: [{ name: "date" }], metrics: [{ name: "totalUsers" }], keepEmptyRows: true };
    const payload = JSON.stringify(body);

    // Try multiple endpoints / approaches
    const attempts = [
      {
        label: "analyticsdata v1beta",
        url: `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      },
      {
        label: "analyticsdata v1",
        url: `https://analyticsdata.googleapis.com/v1/properties/${propertyId}:runReport`,
      },
    ];

    for (const attempt of attempts) {
      try {
        console.log("[ga4] trying", attempt.label, dayBefore, "→", yesterday);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(attempt.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: payload,
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          const data = await res.json() as { rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> };
          const rows = data.rows || [];
          const yRow = rows.find((r) => r.dimensionValues?.[0]?.value === yesterday);
          const dRow = rows.find((r) => r.dimensionValues?.[0]?.value === dayBefore);
          const yVal = yRow ? Number(yRow.metricValues?.[0]?.value ?? null) : null;
          const dVal = dRow ? Number(dRow.metricValues?.[0]?.value ?? null) : null;
          const pct = dVal != null && dVal > 0 ? ((yVal! - dVal) / dVal) * 100 : null;
          console.log("[ga4] success:", { yesterday: yVal, dayBefore: dVal, pct });
          return {
            chartId: "ga4-visitors", title: "GA4 Unique Visitors", kind: "timeseries",
            metricLabel: "Unique Visitors", yesterday, dayBefore,
            yesterdayValue: yVal, dayBeforeValue: dVal, changePct: pct,
          };
        }

        const errText = await res.text();
        console.log("[ga4]", attempt.label, "HTTP", res.status, errText.slice(0, 300));
        // If 403/401, no point retrying other endpoints
        if (res.status === 403 || res.status === 401) {
          return makeError(`GA4 auth error (${res.status}): ${errText.slice(0, 80)}`);
        }
      } catch (e) {
        console.log("[ga4]", attempt.label, "failed:", (e as Error).message);
      }
    }

    return makeError("All GA4 endpoints unreachable — see diagnostics above");
  } catch (err) {
    console.error("[ga4] error:", (err as Error).message);
    return makeError(`GA4: ${(err as Error).message?.slice(0, 100)}`);
  }
}

function makeError(msg: string): ChartSnapshot {
  return {
    chartId: "ga4-visitors", title: "GA4 Unique Visitors", kind: "unknown",
    metricLabel: "Unique Visitors", yesterday: null, dayBefore: null,
    yesterdayValue: null, dayBeforeValue: null, changePct: null, error: msg,
  };
}

function shanghaiDate(offsetDays = 0): string {
  const now = new Date();
  const sh = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  sh.setDate(sh.getDate() + offsetDays);
  return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, "0")}-${String(sh.getDate()).padStart(2, "0")}`;
}
