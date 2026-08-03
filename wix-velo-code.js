// ============================================================
// Wix Velo 后端代码 — http-functions.js
// 最后尝试: 检查 enum 真实类型 + 尝试不同调用模式
// ============================================================

import { ok, unauthorized, serverError } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import { analyticsData } from 'wix-analytics-data.v2';

function offsetDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function fmt(date) {
  return date.toISOString().split('T')[0];
}

export function get_ping(request) {
  return ok({ body: { status: 'ok-v6', time: new Date().toISOString() } });
}

export async function get_uniqueVisitors(request) {
  const key = await getSecret('hermes-api-key');
  const reqKey = request.headers['x-api-key'];
  if (!reqKey || reqKey !== key) {
    return unauthorized({ body: { error: 'Unauthorized' } });
  }

  try {
    const now = new Date();
    const yesterday = fmt(offsetDays(now, -1));
    const dayBefore = fmt(offsetDays(now, -2));

    const ENUM = analyticsData.MeasureNameEnum;

    const results = [];

    // 10: 看枚举值到底是什么类型
    const sess = ENUM.TOTAL_SESSIONS;
    results.push({
      method: 10,
      desc: 'typeof check',
      typeof: typeof sess,
      stringified: JSON.stringify(sess),
      direct: String(sess),
      isObject: sess && typeof sess === 'object',
      keys: sess && typeof sess === 'object' ? Object.keys(sess) : null,
    });

    // 11: 如果枚举值是对象，取 .name 或 .value
    if (sess && typeof sess === 'object') {
      for (const key of Object.keys(sess)) {
        try {
          const r = await analyticsData.getAnalyticsData({
            measurementTypes: [sess[key]],
            timeRange: { from: dayBefore, to: yesterday },
          });
          results.push({ method: 11, desc: `ENUM.TOTAL_SESSIONS.${key}`, ok: true });
        } catch (e) {
          results.push({ method: 11, desc: `ENUM.TOTAL_SESSIONS.${key}`, ok: false, error: e.message?.slice(0, 100) });
        }
      }
    }

    // 12: 试试直接传数字 0,1,2,3
    const testVals = [0, 1, 2, 3, '0', '1', 'TOTAL_SESSIONS', sess];
    for (const val of testVals) {
      try {
        const r = await analyticsData.getAnalyticsData({
          measurementTypes: [val],
        });
        results.push({ method: 12, desc: `measurementTypes: [${JSON.stringify(val)}]`, ok: true, data: r });
        break; // 成功就停
      } catch (e) {
        results.push({ method: 12, desc: `measurementTypes: [${JSON.stringify(val)}]`, ok: false, error: e.message?.slice(0, 80) });
      }
    }

    // 13: 直接用 analyticsData 下的其他方法
    results.push({
      method: 13,
      desc: 'all analyticsData keys',
      keys: Object.keys(analyticsData).map(k => ({
        key: k,
        type: typeof analyticsData[k],
      })),
    });

    return ok({
      body: { yesterday, dayBefore, results },
    });
  } catch (err) {
    return serverError({ body: { error: err.message || String(err) } });
  }
}
