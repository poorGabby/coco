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
| DAU / `fetch_amplitude_metric` | `dau.amplitude-chart-ilhu9t17.calendar-day.wow.v4` | Amplitude Chart `ilhu9t17`: Any Active Event (`_active`) uniques, daily calendar-day intervals, America/Denver, no rolling average, no filters/group-by | Confirmed; current completed calendar day WoW against the same weekday 7 days earlier |
| New Users / `fetch_amplitude_metric` | `new-users.amplitude-chart-1n0bfs5k.daily-uniques.wow.v3` | Amplitude Chart `1n0bfs5k` (`New Users (Daily)`): `[Amplitude] New User` Daily Uniques, single `None` series, America/Denver | Confirmed; latest completed Denver day vs the same weekday 7 days earlier from one `/query` response |
| Purchase Users / `fetch_purchase_users` | `purchase-users.amplitude-chart-bh0r0h4o.wow.v2` | Amplitude Chart `bh0r0h4o`: purchase_completed uniques, All Users | Confirmed; WoW |
| Companion Retention / `fetch_retention_metric` | `companion-retention.amplitude-chart-ji5sqoml.overall-value.cohort-wow.v4` | Amplitude Chart `ji5sqoml`: headline Breakdown Table overall/combined D1/D3/D7; temporary WoW from latest mature cohort vs seven days earlier | `valueScope=overall-combined`; `wowScope=single-cohort-week-over-week` |
| Purchaser Companion Retention / `fetch_retention_metric` | `purchaser-companion-retention.amplitude-chart-5of8047n.overall-value.cohort-wow.v4` | Amplitude Chart `5of8047n`: headline overall/combined D1/D3/D7, purchase_completed >=1 during Last 365 days; temporary cohort WoW | `valueScope=overall-combined`; `wowScope=single-cohort-week-over-week` |
| Daily Revenue / `fetch_daily_revenue` | `daily-revenue.amplitude-chart-qycqvc95.wow.v2` | Amplitude Chart `qycqvc95`: purchase_completed Event Totals × $9.99 | Confirmed; WoW; no Stripe or `/api/2` fallback |

All current metric tools use `America/Denver` date boundaries.

Every formal metric is read only through its standard function. The standard function may read its fixed formal Chart JSON/CSV. Chart access, structure changes, missing cells, immature retention cells, and parse failures fail closed; Stripe and `/api/2` fallback are forbidden.

Every daily metric snapshot records `currentDate`, `currentValue`, `comparisonDate`, `comparisonValue`, and `wowChange`. One Chart response covers the current date and the date 7 days earlier.

Retention snapshots explicitly record `valueScope=overall-combined` and `wowScope=single-cohort-week-over-week`. Headline D1/D3/D7 `numerator/denominator/rate` always come from `series.combined`. Separate `wowCurrent*` and `comparison*` fields contain the two mature single-day cohorts used only for `wowChangePp`; consumers must never substitute those rates for the headline value. When Amplitude exposes previous overall, `wowScope` can be upgraded without changing `valueScope`.
