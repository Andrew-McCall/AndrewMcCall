-- The capital is redundant: cities.capital already flags the capital city
-- (a country's capital is `SELECT name FROM cities WHERE country_slug = $1
-- AND capital` where present). iso2 drives the flag CDN link instead.
ALTER TABLE countries DROP COLUMN capital;
ALTER TABLE countries ADD COLUMN iso2 TEXT; -- lowercase ISO 3166-1 alpha-2; null where Natural Earth has none

-- Natural Earth GDP_MD: gross domestic product in millions of current USD.
-- Null where Natural Earth has no figure (or reports zero, e.g. uninhabited
-- territories) — same convention as `population`.
ALTER TABLE countries ADD COLUMN gdp BIGINT;
