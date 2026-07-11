//! High-level visit statistics. `GET /stats` returns anonymous, aggregated
//! counts suitable for a public-facing overview: totals plus per-day, per-kind,
//! and per-hour-of-day breakdowns. Deliberately coarse — no client IPs, user
//! agents, or per-visit rows ever leave here. The detailed, IP-level view lives
//! behind the authenticated admin surface, not this endpoint.

use chrono::{Duration, NaiveDate, Utc};
use sonic_rs::Serialize;
use std::collections::HashMap;

use crate::config::ApiConfig;
use crate::response::{ApiError, Body, ResponseBuilder};

/// How many days of the per-day series to return, counting back from today
/// (inclusive), with missing days filled as zero so the axis is continuous.
const DAYS: i64 = 30;

#[derive(Serialize)]
struct DayCount {
    /// ISO date (`YYYY-MM-DD`), in UTC.
    day: String,
    count: i64,
}

#[derive(Serialize)]
struct KindCount {
    /// Visit kind: `static`, `js`, or `secret`.
    kind: String,
    count: i64,
}

#[derive(Serialize)]
struct HourCount {
    /// Hour of day in UTC, `0`–`23`.
    hour: i32,
    count: i64,
}

#[derive(Serialize)]
struct StatsJson {
    total: i64,
    /// Distinct client IPs — an aggregate count only; no IP is ever returned.
    unique_visitors: i64,
    per_day: Vec<DayCount>,
    by_kind: Vec<KindCount>,
    by_hour: Vec<HourCount>,
}

/// Handles `GET /stats`: high-level, anonymous visit aggregates as
/// `{total, unique_visitors, per_day, by_kind, by_hour}`. Every breakdown is a
/// pure `COUNT` — the endpoint exposes no client IPs, user agents, or rows.
pub async fn stats_response(config: &ApiConfig) -> hyper::Response<Body> {
    let pool = config.db.pool();

    // Totals across all of history. `unique_visitors` counts distinct IPs but
    // never discloses them.
    let (total, unique_visitors): (i64, i64) = match sqlx::query_as(
        "SELECT COUNT(*), COUNT(DISTINCT client_ip) FROM visits",
    )
    .fetch_one(&pool)
    .await
    {
        Ok(row) => row,
        Err(err) => {
            tracing::error!(error = %err, "failed to load visit totals");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // Per-day counts over the trailing window. Only days with visits come back;
    // the gaps are filled to zero below so the series is continuous.
    let start = Utc::now().date_naive() - Duration::days(DAYS - 1);
    let day_rows: Vec<(NaiveDate, i64)> = match sqlx::query_as(
        "SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) \
         FROM visits \
         WHERE (created_at AT TIME ZONE 'UTC')::date >= $1 \
         GROUP BY day",
    )
    .bind(start)
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to load per-day visits");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // Visits grouped by kind.
    let by_kind: Vec<KindCount> = match sqlx::query_as::<_, (String, i64)>(
        "SELECT kind::text, COUNT(*) FROM visits GROUP BY kind ORDER BY kind",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows
            .into_iter()
            .map(|(kind, count)| KindCount { kind, count })
            .collect(),
        Err(err) => {
            tracing::error!(error = %err, "failed to load visits by kind");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // Visits by hour of day (UTC). Only non-empty hours come back; filled below.
    let hour_rows: Vec<(i32, i64)> = match sqlx::query_as(
        "SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour, COUNT(*) \
         FROM visits GROUP BY hour",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to load visits by hour");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let stats = StatsJson {
        total,
        unique_visitors,
        per_day: fill_days(start, &day_rows),
        by_kind,
        by_hour: fill_hours(&hour_rows),
    };

    ResponseBuilder::new(hyper::StatusCode::OK).json(&stats).into()
}

/// Expands sparse per-day counts into a continuous `DAYS`-long series starting
/// at `start`, with absent days set to zero.
fn fill_days(start: NaiveDate, rows: &[(NaiveDate, i64)]) -> Vec<DayCount> {
    let counts: HashMap<NaiveDate, i64> = rows.iter().copied().collect();
    (0..DAYS)
        .map(|offset| {
            let day = start + Duration::days(offset);
            DayCount {
                day: day.format("%Y-%m-%d").to_string(),
                count: counts.get(&day).copied().unwrap_or(0),
            }
        })
        .collect()
}

/// Expands sparse per-hour counts into a full 0–23 series, absent hours zeroed.
fn fill_hours(rows: &[(i32, i64)]) -> Vec<HourCount> {
    let counts: HashMap<i32, i64> = rows.iter().copied().collect();
    (0..24)
        .map(|hour| HourCount {
            hour,
            count: counts.get(&hour).copied().unwrap_or(0),
        })
        .collect()
}
