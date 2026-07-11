-- The nginx static mirror fires for every file it serves — every asset as well
-- as every page. Recording the requested path lets `/stats` separate real page
-- visits from asset noise, and later break visits down by route.
--
-- Nullable: visits recorded before this migration, and the js/secret pings
-- (which carry no page path), leave it null. Only the path is stored — the
-- query string is stripped before insertion.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS route TEXT;

CREATE INDEX IF NOT EXISTS visits_route_idx ON visits (route);
