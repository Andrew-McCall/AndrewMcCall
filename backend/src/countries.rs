//! Country endpoints. `GET /countries` lists every territory with its
//! population, GDP, top cities (positioned in SVG viewBox coordinates, the
//! capital marked `capital: true`), the URL of its map outline, and its flag.
//!
//! The data lives in the `countries`/`cities` tables and the outlines in
//! `frontend/public/countries/`, both maintained by `tools/update-countries`.
//! The outlines ship with the frontend build, so nginx serves them as static
//! files.

use hyper::header::{CACHE_CONTROL, HeaderValue};
use hyper::StatusCode;
use sonic_rs::Serialize;
use ts_typegen::Ts;
use std::collections::HashMap;

use crate::config::ApiConfig;
use crate::database::models::{City as CityRow, Country as CountryRow};
use crate::response::{ApiError, Body, ResponseBuilder};

/// Public URL prefix of the outlines, served from the frontend build.
const IMAGE_PREFIX: &str = "/countries";

/// Flag CDN serving vector flags at `/{iso2}.svg`.
const FLAG_CDN: &str = "https://flagcdn.com";

#[derive(Serialize, Ts)]
struct City {
    name: String,
    x: f64,
    y: f64,
    population: Option<i64>,
    capital: bool,
}

#[derive(Serialize, Ts)]
struct Country {
    country: String,
    population: Option<i64>,
    gdp: Option<i64>,
    image: String,
    flag: Option<String>,
    cities: Vec<City>,
}

/// Handles `GET /countries`: every territory as
/// `{country, population, gdp, image, flag, cities}`, with `population`,
/// `gdp` and `flag` null where unknown and `cities` positioned in the SVG's
/// viewBox space (the capital marked `capital: true`).
pub async fn list_response(config: &ApiConfig) -> hyper::Response<Body> {
    let pool = config.db.pool();
    let countries: Vec<CountryRow> = match sqlx::query_as(
        "SELECT slug, name, population, iso2, gdp FROM countries ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to load countries");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };
    let cities: Vec<CityRow> = match sqlx::query_as(
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

    let mut by_slug: HashMap<String, Vec<City>> = HashMap::new();
    for city in cities {
        by_slug
            .entry(city.country_slug)
            .or_default()
            .push(City {
                name: city.name,
                x: city.x,
                y: city.y,
                population: city.population,
                capital: city.capital,
            });
    }
    let list: Vec<Country> = countries
        .into_iter()
        .map(|c| Country {
            image: image_url(&c.slug),
            flag: c.iso2.as_deref().map(flag_url),
            cities: by_slug.remove(&c.slug).unwrap_or_default(),
            country: c.name,
            population: c.population,
            gdp: c.gdp,
        })
        .collect();

    // The tables only change when the update tool runs, so let clients and
    // proxies cache for an hour.
    ResponseBuilder::new(StatusCode::OK)
        .header(CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"))
        .json(&list)
        .into()
}

fn image_url(slug: &str) -> String {
    format!("{IMAGE_PREFIX}/{slug}.svg")
}

fn flag_url(iso2: &str) -> String {
    format!("{FLAG_CDN}/{iso2}.svg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_serializes_expected_shape() {
        let entry = Country {
            country: "United Kingdom".into(),
            population: Some(66_834_405),
            gdp: Some(2_827_113),
            image: image_url("united-kingdom"),
            flag: Some(flag_url("gb")),
            cities: vec![City {
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
            r#"{"country":"United Kingdom","population":66834405,"gdp":2827113,"image":"/countries/united-kingdom.svg","flag":"https://flagcdn.com/gb.svg","cities":[{"name":"London","x":508.62,"y":967.28,"population":10979000,"capital":true}]}"#
        );
        // Unknowns serialize as explicit nulls.
        let bare = Country {
            country: "Antarctica".into(),
            population: None,
            gdp: None,
            image: image_url("antarctica"),
            flag: None,
            cities: Vec::new(),
        };
        assert_eq!(
            sonic_rs::to_string(&bare).unwrap(),
            r#"{"country":"Antarctica","population":null,"gdp":null,"image":"/countries/antarctica.svg","flag":null,"cities":[]}"#
        );
    }
}
