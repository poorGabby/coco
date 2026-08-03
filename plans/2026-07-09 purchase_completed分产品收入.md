# Plan: purchase_completed 分产品收入

## Context

当前 `deriveRevenueSnapshot` 把 `Purchase Completed — Unique Users` 的总数 × $9.99 算收入，忽略了用户可能买 $6.99 的商品。需要按 `product` 属性拆分收入。

## 前置条件

- [ ] **Amplitude 上创建新 Chart**：在 Amplitude 里对 `purchase_completed` 事件建一个 **Event Segmentation chart**，Group By `product` 属性。拿到 Chart ID 后加入 `.env` 的 `AMPLITUDE_CHART_IDS`。

## 代码改动（2 个文件）

### 1. `apps/hermes/src/amplitude.ts` — 新增分段 Chart 解析

新增 `fetchGroupedChartSnapshot` 函数，解析 Group By 的 CSV（多 Segment 行）：

```
CSV 结构示例：
Segment         | 7/7 | 7/8
Product: $9.99  |  3  |  5
Product: $6.99  |  1  |  2
```

返回格式：`{ product: string; yesterdayValue: number; dayBeforeValue: number }[]`

### 2. `apps/hermes/src/report.ts` — 重构 `deriveRevenueSnapshot`

改为按 product 分段计算：
```
Revenue = SUM(各 product 的购买数 × 该 product 的价格)
Wow = 基于聚合 Revenue 的环比
```

日报中每条产品线单独列一行，汇总一行：
```
| Daily Revenue (Monthly @ $9.99)     | 39.96 | 19.98 | +100% |
| Daily Revenue (Yearly @ $6.99)      | 6.99  | 6.99  | 0%    |
| Daily Revenue (Total)               | 46.95 | 26.97 | +74%  |
```

## 不改的部分

- `.env` 中原有的 chart IDs 保持不变
- `REVENUE_CHART_ID` 常量改为 `PURCHASE_CHART_ID`（语义更准）
- Product → Price 映射在代码中维护（只有两个 SKU，无需外部配置）

## 验证

1. Amplitude 新 Chart 能正常拉到分 Segment 数据
2. 日报中显示拆分后的收入行
3. 聚合 Revenue 与之前逻辑一致（总数验证）
