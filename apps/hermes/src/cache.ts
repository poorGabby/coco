import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A single entry in the retention history cache */
export type RetentionCacheEntry = {
  chartId: string;
  yesterday: string;
  yesterdayValue: number;
  recordedAt: string;
};

export type RetentionCache = {
  updated: string;
  entries: Record<string, RetentionCacheEntry>;
};

// ── GCS config ──
const GCS_BUCKET = "furever-dock-hermes-retention";
const GCS_OBJECT = "retention-cache.json";
const GCS_UPLOAD_URL = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${GCS_OBJECT}`;
const GCS_DOWNLOAD_URL = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${GCS_OBJECT}?alt=media`;

// ── Local fallback ──
const LOCAL_PATH = process.env.RETENTION_CACHE_PATH ?? "./retention-cache.json";

/** Detect if we're running on Cloud Run (has metadata server) */
function isOnCloudRun(): boolean {
  return !!process.env.K_SERVICE;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Get an access token for GCS — on Cloud Run uses metadata server, locally uses gcloud */
async function getGcsToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  if (isOnCloudRun()) {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cachedToken.token;
  }
  // Local: return empty (falls back to filesystem)
  return "";
}

async function fetchGcsJson(): Promise<RetentionCache | null> {
  try {
    const token = await getGcsToken();
    if (!token) return null;
    const res = await fetch(GCS_DOWNLOAD_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null; // file doesn't exist yet
    if (!res.ok) {
      console.warn(`[cache] GCS download failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as RetentionCache;
    if (!data.entries) data.entries = {};
    return data;
  } catch (err) {
    console.warn(
      "[cache] GCS download error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function uploadGcsJson(cache: RetentionCache): Promise<boolean> {
  try {
    const token = await getGcsToken();
    if (!token) return false;
    cache.updated = new Date().toISOString();
    const res = await fetch(GCS_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cache),
    });
    if (!res.ok) {
      console.warn(`[cache] GCS upload failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      "[cache] GCS upload error:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function loadLocal(): RetentionCache {
  if (!existsSync(LOCAL_PATH)) return { updated: "", entries: {} };
  try {
    const raw = readFileSync(LOCAL_PATH, "utf-8");
    const data = JSON.parse(raw) as RetentionCache;
    if (!data.entries) data.entries = {};
    return data;
  } catch {
    console.warn("[cache] Failed to parse local retention cache, starting fresh");
    return { updated: "", entries: {} };
  }
}

function saveLocal(cache: RetentionCache): void {
  const dir = dirname(LOCAL_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  cache.updated = new Date().toISOString();
  writeFileSync(LOCAL_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/** Load the retention cache. On Cloud Run reads from GCS; locally from filesystem. */
export async function loadRetentionCache(): Promise<RetentionCache> {
  if (isOnCloudRun()) {
    const gcs = await fetchGcsJson();
    if (gcs) {
      console.log("[cache] Loaded retention cache from GCS");
      return gcs;
    }
  }
  return loadLocal();
}

/** Save the retention cache. On Cloud Run writes to GCS; locally to filesystem. */
export async function saveRetentionCache(cache: RetentionCache): Promise<void> {
  if (isOnCloudRun()) {
    const ok = await uploadGcsJson(cache);
    if (ok) {
      console.log("[cache] Saved retention cache to GCS");
      return;
    }
  }
  saveLocal(cache);
}

/** Look up yesterday's retention data for a chart, if available and not stale */
export function getRetentionPrevious(
  cache: RetentionCache,
  chartId: string,
): { yesterday: string; yesterdayValue: number } | null {
  const entry = cache.entries[chartId];
  if (!entry) return null;
  const age = Date.now() - new Date(entry.recordedAt).getTime();
  if (age > 48 * 3600_000) {
    console.log(`[cache] Retention entry for ${chartId} is stale (>48h), ignoring`);
    return null;
  }
  return { yesterday: entry.yesterday, yesterdayValue: entry.yesterdayValue };
}

/** Store today's retention value so tomorrow's run can use it as dayBefore */
export function saveRetentionEntry(
  cache: RetentionCache,
  chartId: string,
  yesterday: string,
  yesterdayValue: number,
): void {
  cache.entries[chartId] = {
    chartId,
    yesterday,
    yesterdayValue,
    recordedAt: new Date().toISOString(),
  };
}
