-- Countries and their headline cities, derived from Natural Earth data by
-- tools/update-countries. That tool owns these tables' contents: each run
-- replaces every row, so nothing else should write here.

CREATE TABLE IF NOT EXISTS countries (
    slug       TEXT PRIMARY KEY,  -- ASCII identifier; also names the SVG under backend/assets/countries/
    name       TEXT NOT NULL UNIQUE,
    capital    TEXT,              -- null where the territory has no capital
    population BIGINT             -- Natural Earth POP_EST; null where unknown
);

-- A country's biggest cities plus its capital. `x`/`y` locate the city inside
-- the country's SVG viewBox (Web Mercator, fitted per country), so the
-- frontend can draw markers straight onto the map.
CREATE TABLE IF NOT EXISTS cities (
    country_slug TEXT NOT NULL REFERENCES countries (slug) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    x            DOUBLE PRECISION NOT NULL,
    y            DOUBLE PRECISION NOT NULL,
    population   BIGINT,          -- city population; null where unknown
    capital      BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (country_slug, name)
);
