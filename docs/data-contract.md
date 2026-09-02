# CoCo Data Contract

CoCo must not let the model invent metric definitions at answer time. The model may choose a registered data tool and fill limited parameters, but the numeric definition must live in code.

## Rules

- Every metric must be exposed through a named tool or script.
- Each tool owns its data source, events, filters, denominator, deduplication, timezone, date boundary, maturity rule, missing-data behavior, and validation.
- Tool results must include a `snapshot` object with:
  - normalized input parameters
  - source
  - `contractVersion`
  - metric definition version
  - pull time
  - coverage range
  - completeness
  - validation status and checks
- A report or answer must be based on the returned snapshot. If data is fetched again, the new snapshot replaces the old one explicitly; results must not be silently mixed.
- Missing or immature data must be returned as `partial`, `empty`, warning, or error. The model must not substitute a similar metric.
- Metric changes require code changes, documentation updates, tests, and a metric version bump.

## Current Contract

Contract version: `coco-data-contract.v1`

Registered agent tools and current verification state:

| Metric/tool | Metric version | Formal source | State |
| --- | --- | --- | --- |
| DAU / `fetch_amplitude_metric` | `dau.amplitude-chart-ilhu9t17.calendar-day.wow.v4` | Amplitude Chart `ilhu9t17`: Any Active Event (`_active`) uniques, daily calendar-day intervals, America/Dawson (fixed UTC-7), no rolling average, no filters/group-by | Confirmed; current completed calendar day WoW against the same weekday 7 days earlier |
| New Users / `fetch_amplitude_metric` | `new-users.amplitude-chart-odptyaey.daily-uniques.wow.v4` | Amplitude Chart `odptyaey` (`New Users (Daily)`): `[Amplitude] New User` Daily Uniques, single All Users series, America/Dawson (fixed UTC-7) | Confirmed; latest completed Dawson day vs the same weekday 7 days earlier from one `/query` response |
| Purchase Users / `fetch_purchase_users` | `purchase-users.amplitude-chart-7n9n6eez.wow.v3` | Amplitude Chart `7n9n6eez`: purchase_completed uniques, All Users, America/Dawson | Confirmed; WoW |
| New User Retention / `fetch_retention_metric` | `new-user-retention.amplitude-chart-lthx47q8.overall-value.cohort-wow.v3` | Amplitude Chart `lthx47q8`: `_new → companion_alive_daily`, N-day / Daily, Last 30 Days, America/Dawson; select All Users (segment 0), ignore No_India comparison; headline Breakdown Table overall/combined D1/D3/D7; temporary WoW from latest mature cohort vs seven days earlier | `valueScope=overall-combined`; `wowScope=single-cohort-week-over-week` |
| Purchaser Companion Retention / `fetch_retention_metric` | `purchaser-companion-retention.amplitude-chart-v5i4q52e.overall-value.cohort-wow.v5` | Amplitude Chart `v5i4q52e`: headline overall/combined D1/D3/D7, purchase_completed >=1 during Last 365 days, America/Dawson; temporary cohort WoW | `valueScope=overall-combined`; `wowScope=single-cohort-week-over-week` |
| Daily Revenue / `fetch_daily_revenue` | `daily-revenue.amplitude-chart-xqmzi8cs.wow.v3` | Amplitude Chart `xqmzi8cs`: purchase_completed Event Totals × $9.99, America/Dawson | Confirmed; WoW; no Stripe or `/api/2` fallback |

All current metric tools use `America/Dawson` (fixed UTC-7) date boundaries.

Every formal metric is read only through its standard function. The standard function may read its fixed formal Chart JSON/CSV. Chart access, structure changes, missing cells, immature retention cells, and parse failures fail closed; Stripe and `/api/2` fallback are forbidden.

Every daily metric snapshot records `currentDate`, `currentValue`, `comparisonDate`, `comparisonValue`, and `wowChange`. One Chart response covers the current date and the date 7 days earlier.

Retention snapshots explicitly record `valueScope=overall-combined` and `wowScope=single-cohort-week-over-week`. Headline D1/D3/D7 `numerator/denominator/rate` always come from `series.combined`. Separate `wowCurrent*` and `comparison*` fields contain the two mature single-day cohorts used only for `wowChangePp`; consumers must never substitute those rates for the headline value. When Amplitude exposes previous overall, `wowScope` can be upgraded without changing `valueScope`.
