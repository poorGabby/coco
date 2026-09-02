/** 自动日报统一日历口径：America/Dawson 全年固定 UTC-7，不使用夏令时。 */
export const REPORT_TIME_ZONE = "America/Dawson";

function formatDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

export function reportDateStr(offsetDays = 0, now = new Date()): string {
  const base = new Date(`${formatDate(now)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

export function reportWeekMonday(offsetWeeks = 0, now = new Date()): string {
  const current = new Date(`${formatDate(now)}T00:00:00Z`);
  const day = current.getUTCDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  current.setUTCDate(current.getUTCDate() - daysFromMonday + offsetWeeks * 7);
  return current.toISOString().slice(0, 10);
}

/** America/Dawson 是全年固定 UTC-7，因此当地 00:00 恒等于 UTC 07:00。 */
export function reportMidnightUtcSec(dateStr: string): number {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid report date: ${dateStr}`);
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), 7) / 1000;
}

export function reportDateOfEpochSec(epochSec: number): string {
  return formatDate(new Date(epochSec * 1000));
}
