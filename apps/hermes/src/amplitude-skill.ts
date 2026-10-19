/**
 * Amplitude Segmentation API v2 Skill
 *
 * 封装 Amplitude /api/2/events/segmentation 端点，将语义化指标名映射到底层 API 调用。
 * 业务层完全不需要知道 URL 格式、参数编码、JSON 结构。
 *
 * ## 设计原则
 * - 输入：语义化指标名 (e.g. "DAU") + 日期范围
 * - 输出：结构化键值对 { "2026-07-09": 72, ... }
 * - 指标注册表 (METRIC_REGISTRY) 是唯一的 Amplitude 事件名集中地：
 *   改事件名只改这里，业务层无感
 */

import { REPORT_TIME_ZONE } from "./report-timezone.js";

// ── 类型 ──

export interface AmplitudeQueryInput {
  metricName: string;       // "DAU" | "WAU" | "New_Users" | "Purchase_Completed"
  startDate: string;        // YYYYMMDD
  endDate: string;          // YYYYMMDD
  groupByProp?: string;     // 分组维度，如 "product"
  groupByType?: "event" | "user";
}

export interface AmplitudeSkillOutput {
  dates: string[];          // ["2026-07-03", "2026-07-04", ...]
  segments: Record<string, SegmentData>;
}

export interface SegmentData {
  dailyTrend: Record<string, number>;  // { "2026-07-09": 72, ... }
  periodTotalUniques: number;
}

interface SegmentationApiData {
  xValues: string[];
  series: number[][];
  seriesLabels: Array<[number, string]>;
  seriesCollapsed: Array<Array<{ value: number }>>;
}

// ── 指标注册表 ──

type MetricConfig = {
  eventType: string;
  measure: "uniques" | "totals" | "average";
};

const METRIC_REGISTRY: Record<string, MetricConfig> = {
  DAU: {
    eventType: "_active",
    measure: "uniques",
  },
  WAU: {
    eventType: "_active",
    measure: "uniques",
  },
  New_Users: {
    eventType: "_new",
    measure: "uniques",
  },
  Purchase_Completed: {
    eventType: "purchase_completed",
    measure: "uniques",
  },
};

// ── Skill 类 ──

const AMPLITUDE_API_V2 = "https://amplitude.com/api/2/events/segmentation";

export class AmplitudeSkill {
  private authHeader: string;

  constructor(apiKey: string, secretKey: string) {
    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
    this.authHeader = `Basic ${auth}`;
  }

  async execute(input: AmplitudeQueryInput): Promise<AmplitudeSkillOutput> {
    const config = METRIC_REGISTRY[input.metricName];
    if (!config) {
      throw new Error(
        `Unknown metric: ${input.metricName}. Registered: ${Object.keys(METRIC_REGISTRY).join(", ")}`,
      );
    }

    // 组装 event JSON
    const eventObj: Record<string, unknown> = { event_type: config.eventType };
    if (input.groupByProp) {
      eventObj.group_by = [{ type: input.groupByType ?? "event", value: input.groupByProp }];
    }

    // API 要求 start/end 为 YYYYMMDD 格式（不带横线）
    // i=1 显式声明日粒度；timezone=America/Dawson 保证固定 UTC-7 日边界
    const params = new URLSearchParams({
      e: JSON.stringify(eventObj),
      start: input.startDate.replace(/-/g, ""),
      end: input.endDate.replace(/-/g, ""),
      m: config.measure,
      i: "1",
      timezone: REPORT_TIME_ZONE,
    });

    // URL 时间戳参数绕开 CDN 缓存
    const url = `${AMPLITUDE_API_V2}?${params.toString()}&_t=${Date.now()}`;

    console.log(
      `[amplitude-skill] ${input.metricName} groupBy=${input.groupByProp ?? "none"} ` +
        `${input.startDate}→${input.endDate}`,
    );

    // 每次 attempt 独立 30s 超时（勿共用 AbortController，否则重试会立刻 aborted）
    for (let attempt = 0; attempt <= 2; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: this.authHeader,
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          },
          signal: ac.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          if (attempt < 2) {
            const delay = (2 ** attempt) * 1000 + Math.random() * 1000;
            console.log(
              `[amplitude-skill] ${res.status} on ${input.metricName}, ` +
                `retry ${attempt + 1}/2 in ${delay | 0}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        }

        const json = (await res.json()) as { data: SegmentationApiData };
        return this.formatOutput(json.data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const cause =
          err instanceof Error && err.cause instanceof Error
            ? ` (${err.cause.message})`
            : "";
        if (attempt < 2) {
          console.warn(
            `[amplitude-skill] ${input.metricName} attempt ${attempt + 1} failed: ${msg}${cause} — retrying...`,
          );
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`Amplitude ${input.metricName}: ${msg}${cause}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("Max retries exceeded");
  }

  /** 检查指标配置是否存在 */
  static isRegistered(metricName: string): boolean {
    return metricName in METRIC_REGISTRY;
  }

  /** 列出所有已注册的指标 */
  static listMetrics(): string[] {
    return Object.keys(METRIC_REGISTRY);
  }

  // ═══ 输出格式化 ═══

  private formatOutput(apiData: SegmentationApiData): AmplitudeSkillOutput {
    const dates: string[] = apiData.xValues;
    const segments: Record<string, SegmentData> = {};

    for (let i = 0; i < apiData.seriesLabels.length; i++) {
      const segName = apiData.seriesLabels[i][1] || "All";
      const dailyValues = apiData.series[i];

      const dailyTrend: Record<string, number> = {};
      dates.forEach((date, idx) => {
        dailyTrend[date] = dailyValues[idx];
      });

      segments[segName] = {
        dailyTrend,
        periodTotalUniques: apiData.seriesCollapsed[i][0].value,
      };
    }

    return { dates, segments };
  }
}
