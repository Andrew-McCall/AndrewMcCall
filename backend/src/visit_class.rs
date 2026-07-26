//! Classifies a logged visit by its `route` into one of three buckets:
//!
//! - `page` — a real page the frontend router serves (or a null route: the
//!   js/secret pings and pre-tracking visits, which are page-side by
//!   convention).
//! - `static` — a non-page route that looks like a static-asset fetch by its
//!   file extension (`/chip.svg`, `/assets/bundle-523fsdg.js`, a `.css`). A real
//!   resource load, not spam.
//! - `robot` — everything else non-page: bot/scanner probes at paths that were
//!   never real, plus a forced set of crawler paths (`/robots.txt`,
//!   `/sitemap.xml`) that are legitimate files but only a crawler ever fetches.
//!
//! The nginx mirror logs a hit for every request it receives — page or not — so
//! `route` alone can't be trusted; this is what actually separates real page
//! visits from asset fetches and bot noise. Both the `/stats` aggregates (via
//! the SQL predicates) and the admin per-visit rows (via [`classify`]) draw
//! their classification from here, so the two never drift.

use std::sync::LazyLock;

/// Every real page route the frontend router serves (the `routes` table in
/// `frontend/src/main.ts`). Keep the two lists in sync.
pub const VALID_ROUTES: &[&str] = &[
    "/",
    "/posts",
    "/secret",
    "/secret/pi",
    "/secret/morse",
    "/secret/canvas",
    "/secret/password",
    "/secret/countries",
    "/secret/visits",
    "/secret/prettier",
    "/secret/vim",
    "/secret/time",
    "/secret/colour",
    "/secret/barcode",
    "/secret/cron",
    "/secret/man",
    "/secret/languages",
    "/secret/python",
    "/secret/notes",
    "/secret/admin",
    "/secret/admin/visits",
    "/secret/admin/posts",
    "/secret/admin/projects",
    "/secret/admin/profile",
    "/secret/admin/details",
];

/// Paths that are *always* robot/crawler noise, whatever they look like. Some
/// are perfectly real files — but only a crawler ever fetches them, so they
/// belong in the robot bucket (and stay red) rather than being mistaken for a
/// static asset. Checked before the asset-extension test, so a match here wins.
pub const ROBOT_ROUTES: &[&str] = &["/robots.txt", "/sitemap.xml"];

/// File extensions (no leading dot) that mark a non-page route as a genuine
/// static-asset fetch rather than a bot/scanner probe. Deliberately excludes
/// `txt`/`xml`, so `/robots.txt`/`/sitemap.xml` fall to the robot bucket even
/// without the `ROBOT_ROUTES` override.
pub const ASSET_EXTS: &[&str] = &[
    "js", "mjs", "css", "map", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff",
    "woff2", "ttf", "eot", "webmanifest",
];

/// Which of the three buckets a visit's route falls into.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VisitClass {
    Page,
    Static,
    Robot,
}

impl VisitClass {
    /// The lowercase wire form used in JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            VisitClass::Page => "page",
            VisitClass::Static => "static",
            VisitClass::Robot => "robot",
        }
    }
}

/// Classifies a single route. Mirrors the SQL predicates below exactly: a null
/// route is a page; a known page route is a page; a forced robot path is a
/// robot; otherwise it's `static` if it ends in a known asset extension and
/// `robot` if not.
pub fn classify(route: Option<&str>) -> VisitClass {
    let Some(route) = route else {
        return VisitClass::Page;
    };
    if VALID_ROUTES.contains(&route) {
        return VisitClass::Page;
    }
    if ROBOT_ROUTES.contains(&route) {
        return VisitClass::Robot;
    }
    if is_asset(route) {
        VisitClass::Static
    } else {
        VisitClass::Robot
    }
}

/// Whether `route`'s final path segment ends in one of `ASSET_EXTS`
/// (case-insensitive) — the same test the SQL `ASSET_EXT_RE` applies.
fn is_asset(route: &str) -> bool {
    let last_segment = route.rsplit('/').next().unwrap_or(route);
    match last_segment.rsplit_once('.') {
        Some((_, ext)) => ASSET_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)),
        None => false,
    }
}

/// Renders a route slice as a Postgres `ARRAY[...]::text[]` literal. Inputs are
/// compile-time constants with no quotes, so plain interpolation is safe.
fn routes_array(routes: &[&str]) -> String {
    let quoted: Vec<String> = routes.iter().map(|r| format!("'{r}'")).collect();
    format!("ARRAY[{}]::text[]", quoted.join(","))
}

/// A Postgres `text[]` literal of `VALID_ROUTES`. Built once at startup;
/// interpolated straight into SQL rather than bound, since the contents are a
/// compile-time constant, never user input.
static VALID_ROUTES_ARRAY: LazyLock<String> = LazyLock::new(|| routes_array(VALID_ROUTES));

/// A Postgres `text[]` literal of `ROBOT_ROUTES`. Same contract as above.
static ROBOT_ROUTES_ARRAY: LazyLock<String> = LazyLock::new(|| routes_array(ROBOT_ROUTES));

/// A case-insensitive Postgres regex matching any `ASSET_EXTS` extension at the
/// end of the path, built from the shared list so it can't drift from `is_asset`.
static ASSET_EXT_RE: LazyLock<String> = LazyLock::new(|| format!(r"\.({})$", ASSET_EXTS.join("|")));

/// SQL predicate keeping only real page visits (null routes included).
pub fn page_only() -> String {
    format!("(route IS NULL OR route = ANY({}))", &*VALID_ROUTES_ARRAY)
}

/// SQL predicate for a non-null known page route — used where the null routes
/// `page_only()` admits can't be grouped or listed (they have no path).
pub fn named_page() -> String {
    format!("route = ANY({})", &*VALID_ROUTES_ARRAY)
}

/// Base predicate for the two noise buckets: a real, non-page route (null
/// routes are page-side, so they're excluded here).
fn not_page() -> String {
    format!(
        "route IS NOT NULL AND NOT (route = ANY({}))",
        &*VALID_ROUTES_ARRAY
    )
}

/// SQL predicate for static-asset fetches: a non-page route that isn't a forced
/// robot path and whose extension marks it as an asset.
pub fn static_only() -> String {
    format!(
        "({}) AND NOT (route = ANY({})) AND route ~* '{}'",
        not_page(),
        &*ROBOT_ROUTES_ARRAY,
        &*ASSET_EXT_RE,
    )
}

/// SQL predicate for robot/scanner noise: a non-page route that is either a
/// forced robot path or doesn't look like a static asset. The exact complement
/// of `static_only()` over non-page routes, so the two partition the noise.
pub fn robot_only() -> String {
    format!(
        "({}) AND (route = ANY({}) OR route !~* '{}')",
        not_page(),
        &*ROBOT_ROUTES_ARRAY,
        &*ASSET_EXT_RE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_and_known_pages_are_page() {
        assert_eq!(classify(None), VisitClass::Page);
        assert_eq!(classify(Some("/")), VisitClass::Page);
        assert_eq!(classify(Some("/secret/pi")), VisitClass::Page);
    }

    #[test]
    fn asset_extensions_are_static() {
        assert_eq!(classify(Some("/chip.svg")), VisitClass::Static);
        assert_eq!(
            classify(Some("/assets/bundle-523fsdg.js")),
            VisitClass::Static
        );
        assert_eq!(classify(Some("/styles/app.CSS")), VisitClass::Static);
    }

    #[test]
    fn robots_txt_and_probes_are_robot() {
        // robots.txt is a real file, but forced to robot and never static.
        assert_eq!(classify(Some("/robots.txt")), VisitClass::Robot);
        assert_eq!(classify(Some("/sitemap.xml")), VisitClass::Robot);
        assert_eq!(classify(Some("/wp-login.php")), VisitClass::Robot);
        assert_eq!(classify(Some("/.env")), VisitClass::Robot);
    }

    #[test]
    fn dot_before_slash_is_not_an_asset() {
        // The `.js` isn't in the final segment, so it isn't an asset fetch.
        assert_eq!(classify(Some("/foo.js/bar")), VisitClass::Robot);
    }
}
