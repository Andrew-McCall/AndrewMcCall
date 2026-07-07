//! Country endpoints. `GET /countries` lists every territory with its
//! capital, population, top cities (positioned in SVG viewBox coordinates),
//! and the URL of its map outline; `GET /countries/{slug}.svg` serves that
//! outline from `assets/countries/`.
//!
//! The data lives in the `countries`/`cities` tables and the SVGs on disk,
//! both maintained by `tools/update-countries`.

use hyper::header::{CACHE_CONTROL, HeaderValue};
use hyper::{Method, StatusCode};
use sonic_rs::Serialize;
use std::collections::HashMap;

use crate::config::ApiConfig;
use crate::database::models::{City, Country};
use crate::response::{ApiError, Body, ResponseBuilder};

/// Where the country SVGs live, relative to the backend's working directory
/// (the systemd unit sets it to the repo's `backend/`, matching `cargo run`).
const SVG_DIR: &str = "assets/countries";

/// Public URL prefix for the image links in the JSON listing. nginx forwards
/// `/api/*` to this backend with the prefix stripped, so `/api/countries/x.svg`
/// arrives here as `/countries/x.svg`.
const IMAGE_PREFIX: &str = "/api/countries";

#[derive(Serialize)]
struct CityJson {
    name: String,
    x: f64,
    y: f64,
    population: Option<i64>,
    capital: bool,
}

#[derive(Serialize)]
struct CountryJson {
    country: String,
    capital: Option<String>,
    population: Option<i64>,
    image: String,
    cities: Vec<CityJson>,
}

/// The tables only change when the update tool runs, so let clients and
/// proxies cache for an hour; the SVGs are keyed by slug and effectively
/// immutable, so they get a day.
fn cacheable(status: StatusCode, max_age: &'static str) -> ResponseBuilder {
    ResponseBuilder::new(status).header(CACHE_CONTROL, HeaderValue::from_static(max_age))
}

/// Handles `GET /countries`: every territory as
/// `{country, capital, population, image, cities}`, with `capital` and
/// `population` null where unknown and `cities` positioned in the SVG's
/// viewBox space.
pub async fn list_response(config: &ApiConfig) -> hyper::Response<Body> {
    let pool = config.db.pool();
    let countries: Vec<Country> =
        match sqlx::query_as("SELECT slug, name, capital, population FROM countries ORDER BY name")
            .fetch_all(&pool)
            .await
        {
            Ok(rows) => rows,
            Err(err) => {
                tracing::error!(error = %err, "failed to load countries");
                return ResponseBuilder::from(ApiError::Internal).into();
            }
        };
    let cities: Vec<City> = match sqlx::query_as(
        "SELECT country_slug, name, x, y, population, capital FROM cities \
         ORDER BY population DESC NULLS LAST, name",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to load cities");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let mut by_slug: HashMap<String, Vec<CityJson>> = HashMap::new();
    for city in cities {
        by_slug
            .entry(city.country_slug)
            .or_default()
            .push(CityJson {
                name: city.name,
                x: city.x,
                y: city.y,
                population: city.population,
                capital: city.capital,
            });
    }
    let list: Vec<CountryJson> = countries
        .into_iter()
        .map(|c| CountryJson {
            image: image_url(&c.slug),
            cities: by_slug.remove(&c.slug).unwrap_or_default(),
            country: c.name,
            capital: c.capital,
            population: c.population,
        })
        .collect();

    cacheable(StatusCode::OK, "public, max-age=3600")
        .json(&list)
        .into()
}

fn image_url(slug: &str) -> String {
    format!("{IMAGE_PREFIX}/{slug}.svg")
}

/// The `{slug}` of a `{slug}.svg` request path segment, or `None` if the name
/// isn't exactly a well-formed slug. Slugs are lowercase ASCII alphanumerics
/// and dashes, so a validated slug can safely name a file under [`SVG_DIR`] —
/// request input never reaches the filesystem un-checked.
fn parse_slug(file: &str) -> Option<&str> {
    let slug = file.strip_suffix(".svg")?;
    let well_formed = !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    well_formed.then_some(slug)
}

/// Handles `/countries/{slug}.svg`, serving the country's SVG outline from
/// [`SVG_DIR`]. Malformed names and unknown slugs are a 404.
pub async fn svg_response(method: &Method, file: &str) -> hyper::Response<Body> {
    if method != Method::GET {
        return ResponseBuilder::from(ApiError::MethodNotAllowed).into();
    }
    let not_found = || ApiError::NotFound(format!("/countries/{file}"));
    let Some(slug) = parse_slug(file) else {
        return ResponseBuilder::from(not_found()).into();
    };

    match smol::fs::read(format!("{SVG_DIR}/{slug}.svg")).await {
        Ok(bytes) => cacheable(StatusCode::OK, "public, max-age=86400")
            .svg(bytes)
            .into(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            ResponseBuilder::from(not_found()).into()
        }
        Err(err) => {
            tracing::error!(slug, error = %err, "failed to read country svg");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_slug_accepts_only_well_formed_names() {
        assert_eq!(parse_slug("france.svg"), Some("france"));
        assert_eq!(parse_slug("cote-d-ivoire.svg"), Some("cote-d-ivoire"));
        assert_eq!(parse_slug("france"), None);
        assert_eq!(parse_slug(".svg"), None);
        assert_eq!(parse_slug("France.svg"), None);
        assert_eq!(parse_slug("../secrets.svg"), None);
        assert_eq!(parse_slug("a/b.svg"), None);
    }

    #[test]
    fn every_asset_is_a_well_formed_slug() {
        // Tests run with the crate root as working directory — the same place
        // the server resolves SVG_DIR from.
        let entries = std::fs::read_dir(SVG_DIR).expect("svg dir missing");
        let mut count = 0;
        for entry in entries {
            let file = entry.unwrap().file_name().into_string().unwrap();
            assert!(parse_slug(&file).is_some(), "bad asset name {file:?}");
            count += 1;
        }
        assert!(count > 200, "expected the full country set, found {count}");
    }

    #[test]
    fn listing_serializes_expected_shape() {
        let entry = CountryJson {
            country: "United Kingdom".into(),
            capital: Some("London".into()),
            population: Some(66_834_405),
            image: image_url("united-kingdom"),
            cities: vec![CityJson {
                name: "London".into(),
                x: 508.62,
                y: 967.28,
                population: Some(10_979_000),
                capital: true,
            }],
        };
        let json = sonic_rs::to_string(&entry).unwrap();
        assert_eq!(
            json,
            r#"{"country":"United Kingdom","capital":"London","population":66834405,"image":"/api/countries/united-kingdom.svg","cities":[{"name":"London","x":508.62,"y":967.28,"population":10979000,"capital":true}]}"#
        );
        // Unknowns serialize as explicit nulls.
        let bare = CountryJson {
            country: "Antarctica".into(),
            capital: None,
            population: None,
            image: image_url("antarctica"),
            cities: Vec::new(),
        };
        assert_eq!(
            sonic_rs::to_string(&bare).unwrap(),
            r#"{"country":"Antarctica","capital":null,"population":null,"image":"/api/countries/antarctica.svg","cities":[]}"#
        );
    }
}
