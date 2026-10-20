# P1 Pulse - Technical Documentation

This document provides detailed technical information for developers and advanced users of P1 Pulse.

> Scope note: this file documents what the code in this repository actually does. Where behaviour is
> known to be wrong or unfinished, it is listed under [Known Issues](#known-issues) rather than
> described as if it worked.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Solar Integration (Solplanet Cloud)](#solar-integration-solplanet-cloud)
- [Utility Scripts](#utility-scripts)
- [JavaScript Modules](#javascript-modules)
- [Configuration Reference](#configuration-reference)
- [Data Flow](#data-flow)
- [Known Issues](#known-issues)

---

## Architecture Overview

P1 Pulse is a PHP/JavaScript web application that provides a modern dashboard for P1 Monitor. It uses
no build tools or package managers — files are served directly. The one third-party runtime
library is Chart.js, vendored in `assets/vendor/chartjs/` and served locally (no CDN), so the UI
works on a P1 Monitor without internet access.

### Code Statistics

| Language   | Lines of Code | Files |
|------------|---------------|-------|
| PHP        | ~5,200        | 30    |
| JavaScript | ~3,900        | 10    |
| CSS        | ~2,400        | 4     |
| **Total**  | **~11,500**   | **44**|

### Request Lifecycle

```
p1mon.php
  ├── requires config.php (session start, P1 Monitor util include, P1Config)
  ├── sanitises ?page= and validates against $validPages
  ├── collects config/visibility/maxValues/energyConfig into $pageData
  └── renderPage($page, $pageData)
        ├── extract($data)              → variables visible to all includes
        ├── components/header.php       → <!DOCTYPE> … opens <html>, <body>, .app-container
        ├── components/sidebar.php      → navigation
        ├── pages/{page}.php            → page body (a fragment, not a full document)
        └── components/footer.php       → includeJS(), page-specific script, window.P1MonConfig,
                                          closes </body></html>
```

Pages are **fragments**. `header.php` opens the document and `footer.php` closes it, so no file in
`pages/` can be rendered standalone.

### Key Design Patterns

- **PHP→JS config bridge**: `components/footer.php` emits `window.P1MonConfig`. This is the only
  channel by which server-side configuration reaches the browser.
- **Module managers**: each JS file is an IIFE exposing one object with `init()` /
  `setupEventListeners()` / `destroy()`, auto-initialising on `DOMContentLoaded` when
  `window.P1MonConfig.currentPage` matches.
- **Section pages**: electricity, gas, solar and costs share one template. The PHP page calls
  `section_toolbar()`, `kpi_strip()` and `chart_card()` from `components/section.php`; KPI cards are
  always Nu, Totaal, Kosten, Gemiddeld, Piek, plus one section-specific card. `P1Section`
  (`section.js`) drives that markup and calls the page's `load(state, isCurrent)`; the page fetches
  data, fills its KPIs and hands points to `P1Chart` (`p1chart.js`). New chart pages should
  follow the same shape.
- **Design tokens**: all colours are CSS custom properties in `variables.css`, one per data series
  (`--series-import`, `--series-gas`, …). JS reads them with `P1Utils.color()`; nothing hard-codes
  a colour. The theme is `<html data-theme="light|dark">`; without it the CSS follows
  `prefers-color-scheme`.
- **Configuration-driven UI**: visibility flags read from P1 Monitor via `config_read()`.

---

## API Reference

### P1 Monitor Native API

These are the endpoints `assets/js/api.js` actually calls. `P1API.fetch()` automatically appends
`json=object` to any URL beginning with `/api`, so responses arrive as objects with named fields
rather than positional arrays.

| Endpoint | Wrapper | Notes |
|----------|---------|-------|
| `GET /api/v1/smartmeter?limit=N` | `getSmartMeter(limit)` | Real-time readings; `CONSUMPTION_W`, `PRODUCTION_W` |
| `GET /api/v1/status` | `getStatus()` | Status rows keyed by `STATUS_ID`; source for `getPhases()` |
| `GET /api/v1/configuration` | `getConfiguration()` | Cached |
| `GET /api/v1/powergas/hour?limit=N` | `getHistoryHour(limit)` | Cached |
| `GET /api/v1/powergas/day?limit=N` | `getHistoryDay(limit)` | |
| `GET /api/v1/powergas/month?limit=N` | `getHistoryMonth(limit)` | |
| `GET /api/v1/powergas/year?limit=N` | `getHistoryYear(limit)` | |
| `GET /api/v1/financial/day?limit=N` | `getFinancial(limit)` | |
| `GET /api/v1/financial/month?limit=N` | `getFinancialMonth(limit)` | |
| `GET /api/v1/financial/year?limit=N` | `getFinancialYear(limit)` | |
| `GET /api/v2/watermeter/day?limit=N` | `getWaterMeter(limit)` | Not called by any page yet |
| `GET /api/v2/watermeter/month?limit=N` | `getWaterMeterMonth(limit)` | Not called by any page yet |
| `GET /api/v1/weather/{hour,day,month,year}?limit=N` | `getWeatherHistory(period, limit)` | Pre-aggregated `TEMPERATURE_LOW/AVERAGE/HIGH` |
| `GET /api/v1/weather?limit=1` | — | Called directly by `header.js` for the current conditions widget. `limit=1` is required: without it the endpoint returns the entire weather history (~3,000 records, ~900KB) for the sake of one record |

History endpoints return newest-first; `getElectricityData()` clones and reverses into chronological
order before building chart data.

Field-name quirk: P1 Monitor spells the local timestamp `TIMESTAMP_lOCAL` (lower-case `l`). The code
matches the API, so do not "correct" it.

### P1API behaviour

- **Caching**: `fetchCached()` only. 5-second TTL, `Map`-backed, expired entries evicted on write.
  Plain `fetch()` is uncached — most calls use it.
- **Connection monitoring**: three consecutive failures flips `connectionStatus.isOnline` to false
  and dispatches a `p1connection` CustomEvent on `document`.
- **No retry logic.** A failed request logs, updates the failure counter, and rethrows. The caller
  decides what to do.

### Custom Solar API

**Location**: `api/solar.php`. **URL**: `/custom/api/solar.php` (hard-coded in the JS callers).
Read-only, unauthenticated, SQLite-backed. Output passes through `JSON_NUMERIC_CHECK`, so numeric
strings are emitted as JSON numbers.

#### Current/realtime data

```
GET /custom/api/solar.php?action=current
```

```json
{
  "power": 1250,
  "energy": 4821.35,
  "energyToday": 8.5,
  "energyMonth": 285.0,
  "status": "normal",
  "timestamp": "2026-01-16 12:40:00"
}
```

`power` is Watts; `energy` (lifetime), `energyToday` and `energyMonth` are kWh, converted from the
Wh stored in the database. `status` is `"normal"` when `inverter_status == 1`, otherwise
`"offline"`. When the table is empty the same shape is returned with zeroes, no `timestamp`, and
`status: "offline"`. On a database or query failure the response is `{"error": "..."}` — callers
must handle a payload with no `power` key.

#### Failure reporting

Both routes distinguish three unavailable states, rather than degrading silently to zero:

| `error` | Meaning |
|---------|---------|
| `Database not found, or not readable by the web server` | `file_exists()` is false — absent, or the directory is not traversable |
| `Database exists but is not readable by the web server` | Present, but file permissions deny the web user |
| `Database schema is missing or incomplete` | Opens, but a required table is absent — typically an empty file left by a PDO connect |
| `Query failed` | Any other query error; details go to the PHP error log, not the response |

On the history routes the key is **additive**: `chartData` and `stats` are still present and
still empty, so a client that ignores `error` behaves exactly as before. An initialised database
with no rows yet returns **no** `error` key — that is a normal state, not a fault.
`assets/js/solar.js` surfaces it as a message instead of an empty chart; the dashboard card and
header widget blank themselves rather than claim zero production.

#### Historical data

```
GET /custom/api/solar.php?period={hours|days|months|years}&zoom={N}&offset={M}
```

`zoom` is clamped server-side: below 1 → 24; hours ≤ 168, days ≤ 365, months ≤ 24, years ≤ 10.
`offset` (default 0, clamped to 0…100000) skips the newest M buckets, for paging back through
history; `stats` cover only the returned window. Both are echoed back.

```json
{
  "period": "hours",
  "zoom": 24,
  "offset": 0,
  "chartData": [
    { "timestamp": "2026-01-16 12:00:00", "unixTimestamp": 1768564800,
      "production": 1.234, "power": 820, "powerMax": 1430 }
  ],
  "stats": {
    "totalEnergy": 8.5,
    "avgPower": 640,
    "peakPower": { "value": 2800, "time": "2026-01-16 12:00:00" },
    "capacityFactor": 9.37
  }
}
```

`production` is kWh per bucket; `power` and `powerMax` are Watts; `capacityFactor` is a percentage.

Per-period differences:

| Period | Extra `chartData` fields | `stats` shape |
|--------|--------------------------|---------------|
| `hours` | — | `totalEnergy`, `avgPower`, `peakPower`, `capacityFactor` |
| `days` | `sunlightHours`, `capacityFactor` | `totalEnergy`, `avgDaily`, `peakPower`, `capacityFactor` (mean of stored daily values) |
| `months` | `avgDaily`, `daysWithData` | `totalEnergy`, `avgMonthly`, `peakPower` (no `capacityFactor`) |
| `years` | `avgMonthly`, `monthsWithData` | `totalEnergy`, `avgYearly`, `peakPower` (no `capacityFactor`) |

`timestamp` is a datetime string for `hours`, `YYYY-MM-DD` for `days`, `YYYY-MM` for `months`, and
the year for `years`. Use `unixTimestamp` for anything date-arithmetic-related.

Callers use raw `fetch()` against this endpoint, **not** `P1API`, so none of the caching or
connection monitoring above applies to solar data.

---

## Database Schema

Solar data is stored in SQLite at `/p1mon/www/custom/data/solar.db`. The path is a constant in
`api/solar.php` and in every script; the `data/` directory is not part of this repository.

`scripts/solar-schema.sql` is the authoritative schema definition. It is read by
`scripts/init-solar-database.php` at install time and by the test harness when building a
temporary database, so the two cannot drift apart. Seven tables:

### solar_realtime

One row per collector run (nominally every 10 minutes), pruned to 7 days by the collector.

```sql
CREATE TABLE solar_realtime (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    power_current INTEGER NOT NULL,           -- Current power in W
    energy_today INTEGER NOT NULL,            -- Today's production in Wh
    energy_month INTEGER NOT NULL,            -- Month's production in Wh
    energy_total INTEGER NOT NULL,            -- Lifetime production in Wh
    inverter_status INTEGER DEFAULT 1,        -- 0=offline, 1=normal, 2=warning, 3=error
    collected_at INTEGER NOT NULL,
    UNIQUE(timestamp)
);
```

### solar_hourly

```sql
CREATE TABLE solar_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,               -- Start of hour (unix)
    energy_produced INTEGER NOT NULL,         -- Wh for this hour
    power_avg INTEGER DEFAULT 0,              -- W
    power_max INTEGER DEFAULT 0,              -- W
    power_min INTEGER DEFAULT 0,              -- W
    samples INTEGER DEFAULT 0,                -- realtime rows aggregated
    aggregated_at INTEGER NOT NULL,
    UNIQUE(timestamp)
);
```

Hourly energy is derived from `energy_today`, the inverter's own running daily counter, read **at
the hour boundaries**: `E(hourEnd) - E(hourStart)`, where each is the most recent online reading at
or before that moment. It is not integrated from power samples.

Evaluating at the boundaries is what makes consecutive hours telescope — one hour's closing reading
is the next hour's opening one — so the sum of the hours equals the counter's movement across the
day. Taking the first and last sample *inside* each hour instead, as this once did, dropped the gap
between the last sample of one hour and the first of the next from both buckets: a third of every
hour at three samples per hour.

Two boundaries need care, and `energyCounterAt()` handles both. Readings are restricted to the local
day containing the hour, because `energy_today` restarts at zero each midnight: without that, a
reading taken at 00:00 would be treated as the closing value of the 23:00 hour and report the day's
last hour as zero. And before the day's first reading the counter is taken as zero rather than
unknown, so the first productive hour counts from the start of the day.

Only samples with `inverter_status = 1` take part. While the inverter is offline the API reports
zeros across every field, including `energy_today`, so those rows are absence of data shaped like a
measurement. Counting them put the entire day's production into whichever hour the inverter came
back, and discarded any hour that ended offline. An hour with no online samples gets no row at all.

One limitation remains: `E-Today` is reported to 0.1 kWh, so an individual hour is quantised to
100 Wh steps. Because the hours telescope, that granularity does not accumulate — daily and longer
totals still match the inverter exactly.

### solar_daily

```sql
CREATE TABLE solar_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                       -- YYYY-MM-DD
    timestamp INTEGER NOT NULL,               -- Start of day (unix)
    energy_produced INTEGER NOT NULL,         -- Wh
    power_peak INTEGER DEFAULT 0,             -- W
    power_peak_time INTEGER DEFAULT 0,        -- unix
    hours_sunlight REAL DEFAULT 0,            -- hours with production > 10W
    capacity_factor REAL DEFAULT 0,           -- percent of rated capacity
    aggregated_at INTEGER NOT NULL,
    UNIQUE(date)
);
```

### solar_monthly

```sql
CREATE TABLE solar_monthly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,                   -- 1-12
    timestamp INTEGER NOT NULL,
    energy_produced INTEGER NOT NULL,         -- Wh
    power_peak INTEGER DEFAULT 0,
    days_with_data INTEGER DEFAULT 0,
    avg_daily_production INTEGER DEFAULT 0,   -- Wh/day
    capacity_factor REAL DEFAULT 0,
    aggregated_at INTEGER NOT NULL,
    UNIQUE(year, month)
);
```

### solar_yearly

```sql
CREATE TABLE solar_yearly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    energy_produced INTEGER NOT NULL,         -- Wh
    power_peak INTEGER DEFAULT 0,
    months_with_data INTEGER DEFAULT 0,
    avg_monthly_production INTEGER DEFAULT 0, -- Wh/month
    capacity_factor REAL DEFAULT 0,
    aggregated_at INTEGER NOT NULL,
    UNIQUE(year)
);
```

### api_cache

Declared for caching Solplanet responses (`endpoint`, `params`, `response`, `cached_at`,
`expires_at`, `UNIQUE(endpoint, params)`). **Currently unused** — nothing reads or writes it.

### collection_metadata

Key/value bookkeeping (`key` TEXT PRIMARY KEY, `value` TEXT, `updated_at` INTEGER). Seeded keys:

| Key | Purpose |
|-----|---------|
| `last_collection_timestamp` | Throttles the collector to one run per 300s unless `--force` |
| `last_hourly_aggregation` | Watermark for hourly rollup |
| `last_daily_aggregation` | Watermark for daily rollup |
| `last_monthly_aggregation` | Watermark for monthly rollup |
| `last_yearly_aggregation` | Watermark for yearly rollup |
| `backfill_status` | `pending` / set by the backfill script |
| `backfill_oldest_date` | Earliest backfilled date |

### Energy units

**Everything in the database is stored in Wh and Watts.** Conversion to kWh happens once, at the
`api/solar.php` boundary.

On the way in, every Solplanet measurement declares its own unit, and the units differ between
fields of the same kind:

```json
"Power":   { "unit": "KW",  "value": 1.22  }
"E-Today": { "unit": "KWh", "value": 12    }
"E-Month": { "unit": "KWh", "value": 239.78 }
"E-Total": { "unit": "MWh", "value": 39.09 }
```

Note the non-SI spellings — `KW` and `KWh` with a capital K, and `KWh` with a capital W.

`lib/SolarUnits.php` converts from the declared unit rather than from a per-field assumption.
`SolarUnits::toWatts()` and `SolarUnits::toWattHours()` match case-insensitively and return `null`
for anything they do not recognise, including a power unit passed where an energy unit belongs.
The collector treats a `null` as fatal for that collection rather than storing a partial reading:
a gap can be backfilled, but a wrong value silently corrupts every aggregate derived from it.

This replaced four hardcoded multipliers, one per field. `Power` was assumed to already be in
Watts when it is in kW, so every stored power reading was 1000× low and `(int)` truncation threw
away the fraction on top — `1.22 kW` became `1 W`.

---

## Solar Integration (Solplanet Cloud)

P1 Monitor has no inverter integration, so solar production is collected separately from the
Solplanet Cloud "End User API" (`https://eu-api-genergal.aisweicloud.com`).

### Authentication

`lib/SolplanetAPI.php` signs each request with HMAC-SHA256 over a canonical string built from the
method, `Accept`, `Content-Type`, the `X-Ca-Key` header and the query string (parameters sorted
alphabetically). Two details are load-bearing and must not be "tidied":

- there is **no space** after the colon in the `X-Ca-Key:` line of the string to sign;
- query parameters are sorted alphabetically before signing *and* before sending.

### Credentials

`lib/SolarConfig.php` resolves credentials in this order:

1. **Environment variables** (highest priority — all five must be present or the whole set is skipped)
2. `/p1mon/config/solplanet.ini` (recommended: outside the web root)
3. `/etc/p1mon/solplanet.ini`
4. `/home/claude/solplanet.ini`
5. `<repo>/config/solplanet.ini`

**solplanet.ini format:**

```ini
[solplanet]
enabled = 1
app_key = your-app-key
app_secret = your-app-secret
api_key = your-plant-api-key
token = your-token
sn = your-inverter-serial
system_capacity_wp = 3780
collection_interval = 10
retention_days = 7
cache_enabled = 1
cache_ttl = 300
log_enabled = 1
log_level = INFO
```

`app_key`, `app_secret`, `api_key` and `sn` are required; the collector aborts without them.
`token` is accepted, stored and then ignored — the End User API does not use it.
Values are rejected if they still start with `YOUR_` or contain `HERE`.

**Environment variables (alternative):**

```bash
export SOLPLANET_APP_KEY="..."       # required
export SOLPLANET_APP_SECRET="..."    # required
export SOLPLANET_API_KEY="..."       # required
export SOLPLANET_TOKEN="..."         # required to be present, otherwise unused
export SOLPLANET_SN="..."            # required
export SOLPLANET_ENABLED="true"      # "false" disables collection
export SOLPLANET_CAPACITY="3780"
export SOLPLANET_INTERVAL="10"
export SOLPLANET_RETENTION="7"
export SOLPLANET_CACHE="true"
export SOLPLANET_CACHE_TTL="300"
export SOLPLANET_LOG="true"
export SOLPLANET_LOG_LEVEL="INFO"
```

### Endpoints used

| Method | Solplanet endpoint | Used by |
|--------|--------------------|---------|
| `getPlantOverview()` | `/getPlantOverview` | `solar-collector.php` — current power and totals |
| `getPlantOutput($period, $date)` | `/getPlantOutput` | `solar-backfill.php` — 72 × 20-minute readings per day |
| `getDeviceList()` | `/devicelist` | connectivity tests |
| `getPlantEvent()` | `/getPlantEvent` | diagnostics |
| `getInverterOverview()` | `/getInverterOverview` | diagnostics |
| `getInverterData()` | `/getInverterData` | diagnostics |
| `testConnection()` | — | runs the first three and summarises |

### Setup Steps

1. **Initialize the database:**
   ```bash
   php scripts/init-solar-database.php
   ```

2. **Test API connectivity:**
   ```bash
   php scripts/test-solar-api.php
   ```

3. **Set up cron for data collection (every 10 minutes):**
   ```bash
   */10 * * * * /usr/bin/php /p1mon/www/custom/scripts/solar-collector.php >> /tmp/solar-collector.log 2>&1
   ```
   The collector self-throttles to one run per 300 seconds regardless of how often cron fires.

4. **Backfill historical data (optional):**
   ```bash
   php scripts/solar-backfill.php --days=30
   ```
   See [Known Issues](#known-issues) before trusting backfilled totals.

### System Capacity

Rated capacity is currently **3,780 W** (14 × 270 Wp panels). It is declared in four places and
they must be kept in step:

| Location | Form |
|----------|------|
| `config.php` → `P1Config::getEnergyConfig()` | `system_capacity_w` — reaches the browser as `P1MonConfig.systemCapacityW` |
| `api/solar.php` | `SYSTEM_CAPACITY_W` constant |
| `solplanet.ini` / `SOLPLANET_CAPACITY` | `system_capacity_wp` |
| `dashboard.js`, `solar.js` | `?? 3780` fallbacks if `P1MonConfig` is absent |

---

## Utility Scripts

All scripts live in `scripts/`, are CLI-only (`#!/usr/bin/env php`), and use hard-coded absolute
paths under `/p1mon/www/custom`. They will not run from an arbitrary checkout.

### Core Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `init-solar-database.php` | Create the SQLite schema (idempotent) | `php init-solar-database.php` |
| `solar-collector.php` | Fetch current data, store, aggregate, prune | `php solar-collector.php [--force] [--verbose]` |
| `solar-backfill.php` | Import historical data from Solplanet | `php solar-backfill.php [--days=N \| --start=DATE --end=DATE] [--delay=N] [--verbose] [--dry-run] [--force] [--help]` |
| `validate-solar-data.php` | Check record counts, gaps, aggregation consistency | `php validate-solar-data.php` |
| `backup-p1mon.sh` | Back up theme, `solar.db`, config and cron from the Docker host | `bash backup-p1mon.sh [-c CONTAINER] [-o DIR]` |
| `restore-p1mon.sh` | Restore such a backup into the (updated) container, from the Docker host | `bash restore-p1mon.sh [-c CONTAINER] [-y] [BACKUP_DIR]` |

`--force` on the collector bypasses both the `enabled` config check and the 300-second throttle.
The backfill defaults to a window ending *yesterday*, to avoid racing the live collector.

#### Two retention windows

Solplanet keeps **monthly history far longer than daily history**, and neither is documented. On
this installation, `getPlantOutput('byyear', 2016)` returns real monthly totals from 2016-06
onward, while `getPlantOutput('bydays', '2016-07-23')` returns a full day of zeroes for a month the
yearly call says produced 475.5 kWh.

Nothing in the response distinguishes "no data" from "no production", so the boundary between the
two windows has to be found by probing. That is what `--probe-daily` does.

The practical consequence is that a complete history needs two imports:

| Period | Source | Resolution | Cost |
|--------|--------|------------|------|
| Since per-day detail begins | `--start`/`--end` (`bydays`) | hourly and daily | one API call per day |
| Everything earlier | `--import-months` (`byyear`) | monthly and yearly | one API call per year |

`--import-months` writes `solar_monthly` and rebuilds `solar_yearly` from it. It leaves `power_peak`
at zero and `days_with_data` at zero, because the yearly endpoint reports energy alone — the month
and year views are correct, the peak-power figures for those months are not available at all.

Existing months are kept rather than overwritten (`INSERT OR IGNORE`), since a month already derived
from daily data carries a real peak and day count that this import cannot supply. `--force`
replaces them anyway and loses those.

One boundary caveat: a month with *partial* daily coverage gets rebuilt from whatever daily rows
exist when a daily backfill finishes, replacing a complete imported total with a partial sum. Run
the daily import over whole months, or re-run `--import-months --force` for the month that straddles
the boundary.

#### Finding out what history exists

Solplanet answers a request for a date it has no data with a **full day of zero-valued points**,
not an error and not an empty array. A range that starts before the plant existed therefore imports
thousands of empty days rather than failing, and each one writes a `solar_daily` row that marks the
day as already imported — making the emptiness permanent without `--force`.

`--survey` asks per year instead of per day, so it finishes in seconds:

```bash
php scripts/solar-backfill.php --start=2016-01-01 --end=2026-09-20 --survey
```

It reports which years hold production and names the earliest, then prints the import command for
that range. Follow it with `--probe-daily`, which samples a midsummer day per year and then narrows
by month, to find where per-day detail actually begins — the survey alone will point at a start date
whose daily data does not exist. `--verbose` additionally dumps each raw response, which is worth having: the shape of a
`byyear` response is not documented and may not match the daily one.

The importer also refuses to write a day whose total production is zero, reporting it as "no data"
and moving on.

#### Backfilling a long range

The backfill makes one API call per day, with `--delay` seconds between them (default 10), so a
multi-year range runs for hours. It prints an estimate up front when the range is large enough to
matter.

It is resumable, and cheaply so: a day already present in `solar_daily` is skipped **without an API
call and without the delay**, so an interrupted run can be restarted with the same arguments and
will race through what it already has. Run it detached:

```bash
nohup php scripts/solar-backfill.php --start=2016-06-01 --end=2026-09-20 \
  > /tmp/backfill.log 2>&1 &
tail -f /tmp/backfill.log
```

Monthly and yearly aggregates are rebuilt from `solar_daily` at the end of each run, so they are
correct as long as the run reaches completion. Re-running after an interruption rebuilds them.

`--force` disables the skip, which is what re-imports days whose stored values are wrong. Use it for
a bounded window rather than a decade, or delete the affected rows and re-run without it.

### Diagnostic Scripts

| Script | Purpose |
|--------|---------|
| `solar-diagnostics.php` | Table-by-table database status (`--table=NAME`, `--limit=N`) |
| `test-solar-api.php` | Solplanet connectivity check |
| `diagnose-solar-api.php` | Deeper API failure diagnosis |
| `check-api-units.php` | Verify API unit formats against expectations |
| `check-db-values.php` | Spot-check stored values |
| `check-schema.php` | Verify the live schema matches `init-solar-database.php` |

### Development Scripts

| Script | Purpose |
|--------|---------|
| `solar-debug.php` | Ad-hoc debugging |
| `debug-solar-dashboard.php` | Reproduce what the dashboard sees |
| `quick-api-test.php` | Minimal API smoke test |
| `discover-historical-api.php` | Explore Solplanet endpoint shapes |
| `test-getopt.php` | Argument-parsing scratch file |

There is also `solar-diagnostics.html` in the repository root — a standalone browser-side diagnostic
page that calls the solar API directly.

---

## JavaScript Modules

Load order is fixed by `config.php::includeJS()`: `logger`, `theme`, `sidebar`, `api`, `header`,
`charts` — then the page-specific module appended by `components/footer.php`.

### logger.js (62 lines)

`P1Logger`. Use this instead of `console` throughout.

- `log()` / `warn()` output only in debug mode; `error()` always outputs.
- Enable with `?debug` in the URL or `P1Logger.enable()`; disable with `P1Logger.disable()`.
- State persists in `localStorage` under `p1mon_debug`.

### api.js (582 lines)

`P1API`. See [API Reference](#api-reference) for the full method list. The one method doing real
work is `getElectricityData(period, limit, includeTemperature, { page })`, which fetches power/gas
history plus optional financial and weather data. Windows are counted in buckets back from the
newest: page 0 is the latest `limit` buckets, page 1 the `limit` before that. It fetches
`limit × (page + 2)` rows and slices them client-side, so the window before the requested one is
available for comparisons. It returns:

```javascript
{
  period, limit, page, hasOlder,
  chartData: [{ timestamp, unixTimestamp, consumption, production, net, gas, tempMin?, tempMax?, tempAvg? }],
  stats:    { totalConsumption, totalProduction, netConsumption, totalGas, totalCost, gasCost,
              costIsEstimate, average, peakConsumption: { value, time }, from, to },
  previous: { ...same shape as stats } | null   // null unless a full previous window exists
}
```

It is used by the electricity page, the gas page (for `chartData[].gas`) and the dashboard.
Costs come from the financial rows inside each window. `totalCost` is electricity only (costs
minus export revenue); `gasCost` is gas. Without financial data (always for hours) they are
estimated from the configured tariffs (`P1Utils.estimateElectricityCost()`: bought × purchase
tariff − delivered × export tariff; gas × gas tariff), and `costIsEstimate` is set.

`getCostData(period, limit, { page })` does the same windowing over `/financial/{day,month,year}`
(there is no hourly financial data) for the costs page. Points are `{ timestamp, unixTimestamp,
electricity, gas, water, revenue, net }` with `revenue` negative so it stacks below zero; stats are
`{ electricity, gas, water, gross, revenue, net, average, peak, from, to }`. P1 Monitor's financial
figures exclude fixed charges (vastrecht).

P1 Monitor's financial gas cost can be wrong for a single bucket while its powergas volume is
right (the month fixture has a EUR 8,146 gas month next to 5 m³). `guardGasCost(financialRows,
powergasRows)` compares each bucket's gas cost with volume × the gas tariff and replaces it with
that estimate when it is more than `GAS_COST_TOLERANCE` (3×) above it plus EUR 1. Both
`getCostData` and `electricityStats` apply it; corrected rows carry `gasCostEstimated: true`.

### utils.js

`P1Utils` — shared helpers: range options per period (`zoomOptions`, `defaultZooms`), Dutch date
formatting (`formatXAxisLabel()`, `formatTooltipTime()`, `formatPeakTime()`), `getPeriodKey()` for
joining weather onto energy buckets, `formatNumber()` / `formatCompact()` (Dutch notation via
`Intl.NumberFormat('nl-NL')`: `1.234,56`; display only, never parse the result),
`amountDecimals(period)` (decimals for kWh and m³: 3 per hour, 2 per day, 1 per month or year),
`tariffs()`,
`color()` (reads a CSS token), `isPhone()`, and the `updateElement()` / `showError()` /
`hideError()` DOM helpers.

### p1chart.js

`P1Chart.create(canvas, config)` — the one chart component, a thin layer over Chart.js. Series are
declared as `{ key, label, type: 'bar'|'line', token, axis? }`; amounts per bucket are bars (grouped
side by side), rates and derived values are lines. An optional right-hand axis (`axes.y2`) carries a
second unit (W, degree days). `setData(points, period, { temperature })` adds a shared temperature
overlay (min–max band behind the bars, average line) on its own axis. Options: `compact` (sparkline,
no axes), `stacked` (bars stack, negatives below zero; lines stay unstacked) and `prefix` (currency
before values, e.g. `'€ '`). `decimals` is a number or `'period'`, which follows
`P1Utils.amountDecimals()` for the period shown. The tooltip is HTML (Chart.js external tooltip,
`.chart-tooltip` in `components.css`) rather than drawn on the canvas, so it is never clipped by a
small chart such as a sparkline: it sits above the data point, flips below when there is no room,
and stays between the header and the phone tab bar. It hides on scroll, resize and a tap outside
the chart. `showTable(el)` renders the same data as a `<table>` (one row per
bucket, one column per visible series) and keeps it in sync; the chart card's "Toon als tabel"
button uses it (via `P1Section`, remembered per section). The legend is rendered as HTML
toggle buttons; colours are re-read on `themechange`. Chart.js is only loaded on pages that use it
(see the script map in `footer.php`).

### section.js

`P1Section.create({ id, load, live })` — controller for the section template:

- **State** `{ period, zoom, page, temperature }` lives in the URL (`period`, `range`, `offset`,
  `temp`) so a view can be shared or reloaded; period, range and temperature are also remembered
  per section in `localStorage` (`p1pulse.section.<id>`).
- **Toolbar**: period tabs (arrow keys move between them; a page can offer fewer with
  `section_toolbar(['periods' => [...]])`, and URL or stored values outside that set fall back to
  the first one), back/forward through history (`page`),
  range as buttons from 600px and a `<select>` below, and the temperature chip.
- **Loading**: every load gets an `isCurrent()` check so a slow response never overwrites a newer
  one. The chart card shows `data-state="loading | ready | empty | error"`; errors offer a retry.
  Throw `P1Section.userError(message)` to show a specific message.
- **KPIs**: `setKpi(key, { value, sub, tone, delta: { current, previous, goodWhen, format, compareText } })`
  renders the change vs the previous window as a percentage, or as an absolute difference
  (`format`) when a percentage means nothing: the previous value is zero or negative (net costs),
  or the change passes ±200% because the previous value is small ("▲ 20,41 kWh", not
  "▲ 1385%"). Without `format` the badge is hidden in those cases, so pass it for every amount.
  The badge's tooltip names both values. `compareText` fills a visible `.kpi-compare` line
  where the card has one (dashboard: "t.o.v. gisteren tot 14:25").
- **Live**: `live()` refreshes the "Nu" card every `P1MonConfig.updateInterval` (at least 10 s),
  paused while the tab is hidden.

### dashboard.js

Top row: three live tiles (net power, solar, weather) using the KPI card component
(`kpi_strip(..., 'is-now')`). Net power is polled from the smart meter; solar and weather are taken
from `header.js` (`window.P1Live` / `p1:live`) instead of being fetched a second time.

Below, one card per utility (electricity, gas, solar, costs) with the same anatomy: today's total
from local midnight with the change vs yesterday up to the same time, a sparkline of today in 24
hourly slots (`P1Chart` with `compact: true`), and two key figures. The costs card uses today's
`/financial/day` row when P1 Monitor has one, otherwise tariff estimates (marked "geschat"), and a
bar showing the electricity/gas split when both are positive.

Live tiles refresh every `P1MonConfig.updateInterval` (at least 10 s), the cards every minute;
nothing is polled while the tab is hidden. The page header shows "Bijgewerkt hh:mm:ss", or a
no-connection warning with the time of the last successful update.

### electricity.js

Electricity page: consumption and export bars, net line, optional temperature, statistics cards.

### gas.js

Gas page: consumption bars and degree days (right-hand axis), optional temperature, gap-filling for
missing periods. Sources its data from `P1API.getElectricityData()` (the `gas` field) and weather via
`P1API.attachWeather()`.

### costs.js

Costs page on the section template, days/months/years only (`section_toolbar(['periods' => …])`).
Stacked bars per utility with export revenue below zero and a net line, all from P1 Monitor's
financial data. KPIs: Nu (current cost per hour, estimated from live power and last hour's gas),
Netto, Kosten, Gemiddeld, Duurste, Opbrengst.

### solar.js

Solar page: production bars, average power on a right-hand W axis, capacity factor, peak power,
estimated sunlight hours, optional temperature. Fetches `/custom/api/solar.php` directly rather than
through `P1API`.

### header.js (255 lines)

Clock (1s), weather widget (5 min), solar production widget (10s) and P1 Monitor update notice (1 h). Interval IDs are collected in
`this.timers`, cleared on `beforeunload` and while the tab is hidden. The latest weather record and
solar reading (`{ power, todayKWh }`, or `null` when the solar database is unavailable) are
published on `window.P1Live` and as a `p1:live` event for the dashboard.

The update notice (`#update-badge`, hidden by default) reads P1 Monitor's own flags from
`/api/v1/status`: `STATUS_ID` 136 (new version) and 137 (new patch), with 66/86 (latest version
and release URL) and 133/134 (latest patch number and URL) for the text and link. P1 Monitor sets
the flags itself when its periodic release check finds something; the badge shows nothing when
neither is `1` or the status cannot be read. Links are restricted to http(s).

### theme.js (245 lines)

Dark/light switching via `<html data-theme>`, persisted to `localStorage` (`p1mon_theme`). An
inline script in `header.php` applies a stored choice before first paint; without one, no attribute
is set and the CSS follows `prefers-color-scheme`. Also updates `<meta name="theme-color">`,
dispatches a `themechange` event (charts and gauges redraw on it), and binds Ctrl/Cmd+Shift+L.

### sidebar.js (412 lines)

Collapse/expand with `localStorage` persistence (`p1mon_sidebar_collapsed`), mobile drawer behaviour
below 1024px, click-outside-to-close. Keeps the menu button's `aria-expanded` in sync. Hidden pages
(gas, water) are left out server-side by `nav_items()` in `components/nav.php`, which also feeds
the phone bottom tab bar (`components/bottom-nav.php`).

There is exactly one menu per width: below 600px the bottom tab bar (every page; no hamburger, the
sidebar is `display: none`, and Inloggen is an icon in the header); 600–1023px the hamburger drawer;
from 1024px the sidebar. A closed drawer is also `visibility: hidden`, so its links are out of
the tab order and the accessibility tree.

---

## Configuration Reference

### P1 Monitor Config Values

Read by `P1Config::get()`. It uses `config_read()` when P1 Monitor's PHP provides it (it is not
defined by `util/p1mon-util.php`, so on a stock device it usually is not). Otherwise it reads
P1 Monitor's own API, `/api/v1/configuration?json=object`: first on `http://127.0.0.1`, then on
the host the page was requested on, with a 2-second timeout. Only the ids in
`P1Config::CONFIG_IDS` are kept, cached in the session for 5 minutes, failures included. When
neither source answers, `get()` returns `null` and every flag falls back to its default; the
Tarieven card on the Kosten page then says the configuration could not be read.

A new id must be added to `P1Config::CONFIG_IDS`, or the API path never returns it.

Note for local testing with `php -S`: the built-in server handles one request at a time, so a
page cannot read the API from the same server. Serve the API on a second port or on port 80.

| Config ID | Read as | Purpose |
|-----------|---------|---------|
| 52 | `maxValues['consumption']` (default 10) | Gauge maximum, kW |
| 53 | `maxValues['production']` (default 10) | Gauge maximum, kW |
| 61 | `show_phase_info` = `(61 == 1)` | Three-phase info — **computed but never consumed** |
| 96 | `hide_water` = `(96 == 0)` | Hides the water utility when the value is 0 |
| 154 | `isFastMode` = `(154 == 1)` | Fast telegram mode → 1s refresh instead of 10s |
| 158 | `hide_gas` = `(158 == 1)` | Hides the gas utility |
| 206 | `hide_peak_kw` = `(206 == 1)` | Peak kW info — **computed but never consumed** |

Note on 96: earlier documentation claimed water visibility was config 157. The code reads **96**,
inverted (hidden when 0, i.e. when no water meter is configured). Config 157 is not read anywhere.

### window.P1MonConfig

Emitted by `components/footer.php`; the only server→client configuration channel.

```javascript
{
  currentPage,              // routes JS module auto-init
  isFastMode,
  maxConsumption,           // kW
  maxProduction,            // kW — currently unused by any module
  updateInterval,           // ms: 1000 in fast mode, else 10000
  visibility,               // { hide_gas, hide_water, hide_peak_kw, show_phase_info }
  systemCapacityW,          // 3780
  electricityCostPerKwh,    // EUR/kWh bought    (P1 config 1 + 2, averaged; default 0.30)
  electricityExportPerKwh,  // EUR/kWh delivered (P1 config 3 + 4, averaged; default 0.30)
  gasCostPerM3,             // EUR/m³            (P1 config 15; default 1.50)
  waterCostPerM3            // EUR/m³            (P1 config 104; default 0)
}
```

These come from `P1Config::getEnergyConfig()` in `config.php`. Tariffs are read from P1 Monitor's
own configuration via `config_read()`, the same values its financial data is calculated with; dal
and piek are averaged because hourly data is not split by tariff. The defaults apply only when
P1 Monitor is unreachable (local development) or a tariff is unset. JS reads them through
`P1Utils.tariffs()`, and only for estimates where P1 Monitor has no financial data (hours, today).
`systemCapacityW` is not in P1 Monitor's configuration; edit it in `config.php`.

### User Preferences

`P1Config::getUserPrefs()` seeds a PHP session array:

```php
[
    'theme' => 'dark',
    'sidebar_collapsed' => false,
    'default_page' => 'dashboard',
    'update_interval' => 10
]
```

None of these are read: the theme lives in `localStorage` (see `theme.js`), and `sidebar_collapsed`,
`default_page` and `update_interval` are never read, and `P1Config::setUserPref()` is never called —
see [Known Issues](#known-issues). Client-side state lives in `localStorage` instead.

### CSS Variables

Defined in `assets/css/variables.css`. `:root` holds the light palette; the dark palette is declared
for `:root[data-theme="dark"]` and, as the system fallback, for `:root:not([data-theme])` inside
`@media (prefers-color-scheme: dark)`.

```css
/* Surfaces and text (remapped per theme) */
--bg-primary, --bg-secondary, --bg-card, --bg-hover
--text-primary, --text-secondary, --border-color, --border-strong, --shadow, --shadow-hover

/* One colour per data series, used by CSS and by charts via P1Utils.color() */
--series-import, --series-export, --series-net, --series-solar, --series-solar-power,
--series-gas, --series-water, --series-cost, --series-degreedays,
--series-temp-max, --series-temp-avg, --series-temp-min, --series-temp-band

/* The same series as text and icon colours (WCAG AA on cards, both themes) */
--series-import-text, --series-export-text, --series-net-text, --series-solar-text,
--series-gas-text, --series-water-text, --series-cost-text

/* Accents: --accent-primary is the filled green (white text 5.5:1); *-text for text */
--accent-primary, --accent-primary-hover, --accent-on-primary,
--accent-success-text, --accent-danger-text, --accent-warning-text

/* Icon tints and chart chrome */
--tint-*, --chart-grid, --chart-text, --chart-tooltip-bg, --chart-tooltip-border
```

**Contrast rule.** The `--series-*` fills are for bars, lines and swatches; many of them are too
light to read as text (amber on white is 2.2:1). Anything that is read (numbers, labels, icons,
links) uses a `*-text` token. The `.is-import` / `.is-gas` / … helpers set `--c` (fill), `--ct`
(text) and `--t` (tint) for their children: use `--ct` for text. Every page passes axe-core
(WCAG 2.1 AA) at phone and desktop width in both themes.

Also defines a type scale (`--text-xs` … `--text-4xl`), spacing (`--space-1` … `--space-12`),
radii, transitions, layout dimensions (`--header-height`, `--bottom-nav-height`),
`--touch-target` and a z-index scale. CSS is mobile first with two breakpoints: 600px (tablet, the
bottom tab bar is replaced by the hamburger drawer) and 1024px (desktop, sidebar in the flow).

---

## Data Flow

### P1 Monitor data (live, not stored)

```
Browser
  └── P1API.fetch('/api/v1/...?json=object')
        └── P1 Monitor API  →  JSON  →  DOM + canvas
              └── re-poll every 10s (1s in fast mode)
```

### Solar data (collected and stored)

```
cron (10 min)
  └── solar-collector.php
        ├── SolarConfig  →  credentials
        ├── SolplanetAPI.getPlantOverview()  →  Solplanet Cloud
        ├── INSERT solar_realtime           (Wh / W)
        ├── aggregate → solar_hourly / _daily / _monthly / _yearly
        └── DELETE solar_realtime older than 7 days

Browser
  └── fetch('/custom/api/solar.php?...')
        └── api/solar.php  →  SQLite  →  JSON (Wh→kWh)  →  DOM + canvas
```

### Data Storage Summary

| Data Type | Storage | Retention |
|-----------|---------|-----------|
| Theme choice | `localStorage` (`p1mon_theme`) | Permanent |
| Sidebar state | `localStorage` (`p1mon_sidebar_collapsed`) | Permanent |
| Debug flag | `localStorage` (`p1mon_debug`) | Permanent |
| Session prefs | PHP session | Session lifetime (largely unused) |
| Solar realtime | SQLite | 7 days |
| Solar aggregated | SQLite | Permanent |
| P1 Monitor data | API only | Not stored |

---

## Known Issues

### Backfilled history before the unit fix is wrong and must be re-imported

**Resolved in code, but existing rows are still bad.** `solar-backfill.php` read the response's
`dataunit` into a variable and then ignored it, treating every power reading as watts. When the API
reports kW, that divided the whole import by a thousand.

The fingerprint of an affected row is `samples = 3` — the backfill writes one sample per
20-minute reading, where the live collector writes one per collection — together with single-digit
`power_avg` and `energy_produced` during daylight hours.

`docs/PHASE6A_HANDOVER.md` recorded this as "roughly 3× too low", which was a misdiagnosis of the
same fault measured against a different comparison.

**Action required**: rows imported before the fix are not salvageable in place; re-run
`solar-backfill.php --force` for the affected range.

### Device-only state is not in this repository

Three things live only on the P1 Monitor host and are restored by no deployment:
`data/solar.db`, `/p1mon/config/solplanet.ini`, and the collector's cron entry. Losing the
SD card or reinstalling P1 Monitor loses all three at once. `.gitignore` keeps the first two
out of this public repository; the README documents restoring all three.

### Backing up before a P1 Monitor update

Updating a Docker install of P1 Monitor replaces the container, and with it anything not on a
volume — potentially the whole of `/p1mon/www/custom`. `scripts/backup-p1mon.sh` runs **on the
Docker host** and pulls the theme, a consistent snapshot of `solar.db` (via `VACUUM INTO`, safe
while the collector runs), `/p1mon/config`, the container's crontabs and its `docker inspect`
output into `~/p1mon-backups/<timestamp>/`.

```bash
# On the host. The script is also inside the container, so copy it out once:
docker cp p1monitor:/p1mon/www/custom/scripts/backup-p1mon.sh ~/
bash ~/backup-p1mon.sh             # auto-detects the container; -c NAME to pick one
```

#### Restoring a backup

The backup also copies `scripts/restore-p1mon.sh` to `~/p1mon-backups/`, so it survives the update.
Once the new container is running:

```bash
bash ~/p1mon-backups/restore-p1mon.sh              # newest backup; asks before changing anything
bash ~/p1mon-backups/restore-p1mon.sh ~/p1mon-backups/20260929-113441   # a specific one
```

It verifies `SHA256SUMS` first and stops on any mismatch. It then:

- moves an existing `/p1mon/www/custom` aside to `custom.pre-restore-<timestamp>` (not deleted)
  and extracts the theme with its original owners and modes;
- copies `solar.db` back and restores the owner and mode recorded in `ownership.txt`, then runs
  an integrity check;
- extracts `/p1mon/config`;
- adds only the cron lines that refer to `/p1mon/www/custom` to the matching user's crontab, and
  only if they are not there yet. P1 Monitor's own jobs come from the new version and are not
  touched, so re-running is safe.

Check the result with `php scripts/solar-diagnostics.php` in the container, and check the theme
against the new version's API before deleting the `custom.pre-restore-*` directory.

### `file_exists()` cannot distinguish absent from unreadable

`getSolarDB()` and the collector both gate on `file_exists()`, which returns false when the
file is missing *and* when the web server user cannot traverse the containing directory. The
API therefore reports "Database not found, or not readable by the web server" rather than
asserting which. Diagnosing it needs `ls -la` on the device.

This bit in practice: the web server reported the database as unavailable while the same
file opened fine from a CLI shell.

### Capacity factor is calculated three different ways

For the same underlying data:

- `api/solar.php` divides by `zoom` hours (and approximates months as 30 days, years as 365);
- `solar.js::totals()` divides by the zoom window, same approximations;
- `dashboard.js::showSolar()` divides by *hours elapsed so far today*.

The dashboard card and the solar page will therefore disagree about the same day. There is no single
agreed definition in the codebase.

### Hard-coded absolute paths

`api/solar.php` and every script hard-code `/p1mon/www/custom/...`, and the JS callers hard-code
`/custom/api/solar.php`, while `config.php` defines an unused `CUSTOM_BASE_URL`. The installation is
not relocatable, despite the README suggesting `/var/www/html/custom`.

### Unimplemented pages and unused surface

- `pages/water.php` is a placeholder. Building it waits for an installation with an active water
  meter: on the reference device water measurement is off (config 96 = 0) and
  `/api/v2/watermeter/*` returns `[]`, so the field names cannot be verified.
- Peak kW display and three-phase info are read from config and passed to the browser but never
  rendered; `P1API.getPhases()`, `getStatus()` and both watermeter methods have no callers.
- The `api_cache` table is created but never used.
- `P1MonConfig.maxProduction` is emitted but never read.

### Solar is fetched outside `P1API`

`header.js`, `dashboard.js` and `solar.js` call `/custom/api/solar.php` with raw `fetch()`, so those
requests get neither `P1API`'s caching nor its connection tracking. The dashboard no longer polls
the live solar reading itself (it reuses the header's), but it still fetches 48 hours of solar data
every minute next to the header's 24 hours every 10 seconds.

---

## Security Considerations

- Page routing validates against an explicit whitelist after stripping everything but `[a-z0-9_]`.
- `api/solar.php` is read-only and uses prepared statements; `zoom` is cast to `int` and clamped.
- The solar API is **unauthenticated** — anyone who can reach the P1 Monitor host can read solar
  production history. Consider this when exposing the host beyond the LAN.
- `<meta name="robots" content="noindex">` on every page.
- Solplanet credentials belong in a file outside the web root (`/p1mon/config/solplanet.ini`) or in
  environment variables. `SolarConfig::getAll()` masks them by default.
- No CSRF protection exists; there are currently no state-changing endpoints to protect.

---

## Development

### Adding a New Page

1. Create `pages/newpage.php` as a fragment (no `<html>`/`<body>`; 8-space base indent to match),
   with `<main class="main-content" id="main" tabindex="-1">` so the skip link lands there.
2. Add the page name to `$validPages` in `p1mon.php`.
3. Add it to `nav_items()` in `components/nav.php`; the sidebar, the phone tab bar and the page
   title all read from there.
4. Create `assets/js/newpage.js` as an IIFE exposing a manager that auto-inits when
   `P1MonConfig.currentPage` matches.
5. Register the script in the page-specific block in `components/footer.php`
   (**not** in `config.php::includeJS()`, which is for globally loaded modules only).

For a chart page, use `P1Section` for the controls and `P1Chart` for the chart (see
`electricity.js`), and add `$chartScripts` to the page's entry in `footer.php`.

### Running the tests

```bash
php tests/run-all.php                          # every suite; exit 0 on success, 1 on any failure

php tests/run-solar-units-tests.php            # unit conversion only
php tests/run-solar-collector-tests.php        # collector aggregation only
php tests/run-solar-api-tests.php              # the solar API only
php tests/run-solar-api-tests.php --verbose    # also print every response body
php tests/run-solar-api-tests.php --keep       # leave the temporary databases for inspection
node tests/run-cost-guard-tests.js             # gas cost guard in api.js (not part of run-all.php)
```

`tests/assert.php` holds the shared assertion helpers. `tests/run-solar-units-tests.php` pins
`SolarUnits` against a real `getPlantOverview` response recorded in the file, so the expectations
are measured against something that actually happened rather than an invented example.

The harness builds a temporary SQLite database from `scripts/solar-schema.sql`, seeds it with
known values, and checks `api/solar.php` against them: unit conversion, chronological ordering,
statistics, zoom clamping, per-period response shapes, and the empty and missing database cases.

Each request runs in its own process via `tests/solar-api-request.php`, because `api/solar.php`
declares functions and constants at file scope and can only be included once per process. That
shim pre-defines `SOLAR_DB_PATH` and `SYSTEM_CAPACITY_W`, which `api/solar.php` honours through
`if (!defined(...))` guards; nothing defines them in normal use, so production behaviour is
unchanged.

There is no test framework — the project has no package manager and no dependencies, and the
harness keeps it that way.

### Code Conventions

- **PHP**: static `P1Config`, no instantiation. Includes read variables placed in scope by
  `extract()` inside `renderPage()`.
- **JavaScript**: one IIFE per file, `'use strict'`, a single `XManager` object literal with
  `init()` / `setupEventListeners()` / `destroy()`. Timers tracked and cleared on `beforeunload`.
- **Logging**: `P1Logger` only, never bare `console`.
- **DOM**: `textContent` and `replaceChildren()`; never `innerHTML` with data.
- **CSS**: organised by purpose — `variables`, `base`, `layout`, `components`, `dashboard`. Mobile
  first; colours only through tokens.
- **Language**: UI strings in Dutch, code and comments in English.

---

*Last updated: September 2026*
