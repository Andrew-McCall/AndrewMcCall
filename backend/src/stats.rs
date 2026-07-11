//! High-level visit statistics. `GET /stats` returns anonymous, aggregated
//! counts suitable for a public-facing overview: totals plus per-day, per-kind,
//! and per-hour-of-day breakdowns. Deliberately coarse — no client IPs, user
//! agents, or per-visit rows ever leave here. The detailed, IP-level view lives
//! behind the authenticated admin surface, not this endpoint.
//!
//! Day and hour buckets are computed in the caller's timezone, taken from the
//! `tz` query parameter (an IANA name such as `Europe/London`, defaulting to
//! `UTC`). Postgres does the conversion via `AT TIME ZONE`, so DST transitions
//! are handled correctly rather than with a naive fixed offset.
//!
//! An optional `route` query parameter narrows every aggregate to a single page
//! path (e.g. `route=/secret/pi`); absent, the counts span all pages. The
//! `by_route` breakdown always lists the busiest pages regardless, so it can
//! populate a route picker.

use chrono::NaiveDate;
use sonic_rs::Serialize;

use crate::config::ApiConfig;
use crate::response::{ApiError, Body, ResponseBuilder};

/// How many days of the per-day series to return, counting back from today
/// (inclusive) in the caller's timezone. `generate_series` fills empty days as
/// zero so the axis is continuous.
const DAYS: i32 = 30;

/// SQL predicate keeping only real page visits. The nginx mirror logs every
/// static send, so `route` holds asset paths (`/assets/app.js`, `/favicon.ico`)
/// alongside page paths (`/`, `/secret/pi`); assets always end in a file
/// extension, pages never do, so a trailing `.ext` marks an asset to drop. Null
/// routes — the js/secret pings and pre-tracking visits — are kept.
const PAGE_ONLY: &str = "(route IS NULL OR route !~* '\\.[^/]+$')";

#[derive(Serialize)]
struct DayCount {
    /// ISO date (`YYYY-MM-DD`) in the caller's timezone.
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
    /// Hour of day in the caller's timezone, `0`–`23`.
    hour: i32,
    count: i64,
}

#[derive(Serialize)]
struct RouteCount {
    /// The page path, e.g. `/` or `/secret/pi`.
    route: String,
    count: i64,
}

/// How many of the busiest pages to list in `by_route` — enough to populate a
/// picker without unbounding the response.
const ROUTES: i64 = 20;

#[derive(Serialize)]
struct StatsJson {
    total: i64,
    /// Distinct client IPs — an aggregate count only; no IP is ever returned.
    unique_visitors: i64,
    /// The page the aggregates are filtered to, echoed back, or `null` when the
    /// counts span all pages.
    route: Option<String>,
    per_day: Vec<DayCount>,
    by_kind: Vec<KindCount>,
    by_hour: Vec<HourCount>,
    /// The busiest pages overall — always spans all pages, so it stays a stable
    /// menu even when the other aggregates are filtered to one `route`.
    by_route: Vec<RouteCount>,
}

/// Handles `GET /stats`: high-level, anonymous visit aggregates as
/// `{total, unique_visitors, route, per_day, by_kind, by_hour, by_route}`. Every
/// breakdown is a pure `COUNT` — the endpoint exposes no client IPs, user
/// agents, or rows.
///
/// `query` is the raw request query string. A `tz` parameter selects the
/// timezone for day/hour bucketing (default `UTC`); an optional `route`
/// parameter narrows every aggregate except `by_route` to that single page.
pub async fn stats_response(config: &ApiConfig, query: Option<&str>) -> hyper::Response<Body> {
    let pool = config.db.pool();
    let tz = timezone(query);
    let route = route_param(query);

    // When a page is selected the aggregates match it exactly, bound as a
    // parameter; otherwise they fall back to `PAGE_ONLY` (all pages, no assets).
    // `filter(n)` yields the predicate with the route bound at `$n`, and
    // `bind_route` appends that bind only when a route is set — the two must
    // agree so the parameter count matches.
    let filter = |idx: usize| match route {
        Some(_) => format!("route = ${idx}"),
        None => PAGE_ONLY.to_string(),
    };

    // Totals over the selected page (or all pages). `unique_visitors` counts
    // distinct IPs but never discloses them.
    let sql = format!(
        "SELECT COUNT(*), COUNT(DISTINCT client_ip) FROM visits WHERE {}",
        filter(1)
    );
    let mut q = sqlx::query_as::<_, (i64, i64)>(&sql);
    if let Some(route) = &route {
        q = q.bind(route);
    }
    let (total, unique_visitors): (i64, i64) = match q.fetch_one(&pool).await {
        Ok(row) => row,
        Err(err) => {
            tracing::error!(error = %err, "failed to load visit totals");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // Per-day counts over the trailing window, bucketed in `tz`. `generate_series`
    // supplies every day in range so days with no visits come back as zero.
    let sql = format!(
        "SELECT gs::date AS day, COALESCE(v.count, 0)::bigint \
         FROM generate_series( \
                  (now() AT TIME ZONE $1)::date - ($2::int - 1), \
                  (now() AT TIME ZONE $1)::date, \
                  interval '1 day' \
              ) AS gs \
         LEFT JOIN ( \
             SELECT (created_at AT TIME ZONE $1)::date AS day, COUNT(*) AS count \
             FROM visits WHERE {} GROUP BY day \
         ) v ON v.day = gs::date \
         ORDER BY day",
        filter(3)
    );
    let mut q = sqlx::query_as::<_, (NaiveDate, i64)>(&sql)
        .bind(&tz)
        .bind(DAYS);
    if let Some(route) = &route {
        q = q.bind(route);
    }
    let day_rows: Vec<(NaiveDate, i64)> = match q.fetch_all(&pool).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, %tz, "failed to load per-day visits");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // Visits grouped by kind.
    let sql = format!(
        "SELECT kind::text, COUNT(*) FROM visits WHERE {} GROUP BY kind ORDER BY kind",
        filter(1)
    );
    let mut q = sqlx::query_as::<_, (String, i64)>(&sql);
    if let Some(route) = &route {
        q = q.bind(route);
    }
    let by_kind: Vec<KindCount> = match q.fetch_all(&pool).await {
        Ok(rows) => rows
            .into_iter()
            .map(|(kind, count)| KindCount { kind, count })
            .collect(),
        Err(err) => {
            tracing::error!(error = %err, "failed to load visits by kind");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // Visits by hour of day in `tz`. `generate_series(0, 23)` fills empty hours.
    let sql = format!(
        "SELECT gs AS hour, COALESCE(v.count, 0)::bigint \
         FROM generate_series(0, 23) AS gs \
         LEFT JOIN ( \
             SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $1)::int AS hour, COUNT(*) AS count \
             FROM visits WHERE {} GROUP BY hour \
         ) v ON v.hour = gs \
         ORDER BY hour",
        filter(2)
    );
    let mut q = sqlx::query_as::<_, (i32, i64)>(&sql).bind(&tz);
    if let Some(route) = &route {
        q = q.bind(route);
    }
    let hour_rows: Vec<(i32, i64)> = match q.fetch_all(&pool).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, %tz, "failed to load visits by hour");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // The busiest pages, for the route picker. Always spans all pages (ignoring
    // the selected `route`) and lists only real page paths, never assets or the
    // null-route pings.
    let by_route: Vec<RouteCount> = match sqlx::query_as::<_, (String, i64)>(
        "SELECT route, COUNT(*) FROM visits \
         WHERE route IS NOT NULL AND route !~* '\\.[^/]+$' \
         GROUP BY route ORDER BY COUNT(*) DESC, route LIMIT $1",
    )
    .bind(ROUTES)
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows
            .into_iter()
            .map(|(route, count)| RouteCount { route, count })
            .collect(),
        Err(err) => {
            tracing::error!(error = %err, "failed to load visits by route");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let stats = StatsJson {
        total,
        unique_visitors,
        route,
        per_day: day_rows
            .into_iter()
            .map(|(day, count)| DayCount {
                day: day.format("%Y-%m-%d").to_string(),
                count,
            })
            .collect(),
        by_kind,
        by_hour: hour_rows
            .into_iter()
            .map(|(hour, count)| HourCount { hour, count })
            .collect(),
        by_route,
    };

    ResponseBuilder::new(hyper::StatusCode::OK)
        .json(&stats)
        .into()
}

/// Percent-decodes the first value of query parameter `key`, if present.
fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| {
            percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned()
        })
}

/// Extracts a validated IANA timezone name from the `tz` query parameter,
/// falling back to `UTC` when absent or malformed. Validation keeps only names
/// made of the characters IANA zones use, so an untrusted value can't smuggle
/// SQL into the (parameterised, but still) `AT TIME ZONE` clause or trip a
/// database error on obvious junk.
fn timezone(query: Option<&str>) -> String {
    query_param(query, "tz")
        .filter(|tz| is_valid_tz(tz))
        .unwrap_or_else(|| "UTC".to_string())
}

/// Extracts the `route` query parameter to filter the aggregates by page, or
/// `None` to span all pages. Kept only when it looks like a page path — an
/// absolute path of a bounded length. The value is always bound as a query
/// parameter, so this guards against junk and unbounded input, not injection.
fn route_param(query: Option<&str>) -> Option<String> {
    query_param(query, "route").filter(|r| is_valid_route(r))
}

/// Whether `route` looks like a page path: absolute (`/…`), of bounded length,
/// and free of control characters.
fn is_valid_route(route: &str) -> bool {
    route.starts_with('/')
        && route.len() <= 256
        && !route.chars().any(|c| c.is_control())
}

/// Whether `tz` looks like a well-formed IANA timezone name (e.g. `UTC`,
/// `Europe/London`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`). Browsers
/// derive the value from `Intl…timeZone`, so real names always pass; this just
/// rejects anything outside the small IANA character set.
fn is_valid_tz(tz: &str) -> bool {
    !tz.is_empty()
        && tz.len() <= 64
        && tz
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '+' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timezone_defaults_to_utc() {
        assert_eq!(timezone(None), "UTC");
        assert_eq!(timezone(Some("")), "UTC");
        assert_eq!(timezone(Some("foo=bar")), "UTC");
    }

    #[test]
    fn timezone_reads_and_validates_tz_param() {
        assert_eq!(timezone(Some("tz=Europe%2FLondon")), "Europe/London");
        assert_eq!(timezone(Some("a=1&tz=Etc%2FGMT%2B5&b=2")), "Etc/GMT+5");
        assert_eq!(
            timezone(Some("tz=America%2FArgentina%2FBuenos_Aires")),
            "America/Argentina/Buenos_Aires"
        );
        // Malformed values fall back to UTC rather than reaching the database.
        assert_eq!(timezone(Some("tz=%27%3B+DROP")), "UTC");
        assert_eq!(timezone(Some("tz=has space")), "UTC");
    }

    #[test]
    fn route_param_absent_is_none() {
        assert_eq!(route_param(None), None);
        assert_eq!(route_param(Some("tz=UTC")), None);
    }

    #[test]
    fn route_param_reads_and_validates_route() {
        assert_eq!(route_param(Some("route=%2F")), Some("/".to_string()));
        assert_eq!(
            route_param(Some("tz=UTC&route=%2Fsecret%2Fpi")),
            Some("/secret/pi".to_string())
        );
        // Relative or over-long paths are rejected rather than reaching the query.
        assert_eq!(route_param(Some("route=secret")), None);
        assert_eq!(route_param(Some(&format!("route=%2F{}", "a".repeat(256)))), None);
    }
}
