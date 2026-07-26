//! Classifies a logged visit by its `route` into one of three buckets:
//!
//! - `page` — a real page the frontend router serves (or a null route: the
//!   js/secret pings and pre-tracking visits, which are page-side by
//!   convention).
//! - `static` — a non-page route that points at a genuine site asset: an exact
//!   root public file (`/chip.svg`, `/canvas.wasm`) or a hash-stamped `/assets/…`
//!   bundle (`/assets/index-yXm2gtty.js`, a `.css`). A real resource load, not
//!   spam. A bare extension match elsewhere (`/random.js`, `/assets/jquery.js`)
//!   does *not* qualify — that's a bot probe and falls to `robot`.
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
/// without the `ROBOT_ROUTES` override. The extension alone isn't enough — the
/// path must also sit under a real asset location (see below), or a bot probing
/// `/random.js` or `/photo.jpg` would read as a real fetch.
pub const ASSET_EXTS: &[&str] = &[
    "js", "mjs", "wasm", "css", "map", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico",
    "woff", "woff2", "ttf", "eot", "webmanifest",
];

/// Path prefix the frontend's hashed bundles live under (`/assets/index-*.js`,
/// `/assets/*.css`). A non-page route here only counts as a genuine bundle fetch
/// if it also carries Vite's content-hash suffix (see `is_hashed_bundle`) — a
/// bare extension here (`/assets/jquery.js`) is still a bot probe. A matching
/// extension anywhere else at the root only counts if it's one of the exact
/// `STATIC_ASSET_FILES` below.
pub const STATIC_ASSET_PREFIX: &str = "/assets/";

/// The exact root-level public files the site actually serves (from
/// `frontend/public`). Anything else at the root that merely *looks* like an
/// asset (`/backup.js`, `/logo.jpg`) is a bot probe at a path that was never
/// real, so it stays robot noise rather than inflating the static count.
pub const STATIC_ASSET_FILES: &[&str] =
    &["/canvas.wasm", "/chip.svg", "/nojs.png", "/nojs-stars.png"];

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
/// robot; otherwise it's `static` if it points at a genuine site asset (see
/// [`is_asset`]) and `robot` if not.
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

/// Whether `route` points at a genuine site asset, mirroring `is_static_asset_sql`:
/// an exact root public file, or a hash-stamped `/assets/…` bundle. A bare
/// extension match — at some other root path (`/random.js`, `/photo.jpg`) or an
/// un-hashed name under `/assets/` (`/assets/jquery.js`) — is *not* an asset;
/// that's a bot probe.
fn is_asset(route: &str) -> bool {
    if STATIC_ASSET_FILES.contains(&route) {
        return true;
    }
    route.starts_with(STATIC_ASSET_PREFIX) && is_hashed_bundle(route)
}

/// Whether `route`'s final segment is a Vite-hashed bundle: a name ending in
/// `-<8 chars>.<ext>`, where the 8 characters are base64url (`[A-Za-z0-9_-]`,
/// so the hash may itself contain `-`/`_`) and `<ext>` is a known asset
/// extension. Mirrors the SQL `ASSET_BUNDLE_RE` exactly.
fn is_hashed_bundle(route: &str) -> bool {
    let segment = route.rsplit('/').next().unwrap_or(route);
    let Some((stem, ext)) = segment.rsplit_once('.') else {
        return false;
    };
    if !ASSET_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
        return false;
    }
    // The stem must end in `-` followed by exactly 8 base64url characters.
    let chars: Vec<char> = stem.chars().collect();
    let n = chars.len();
    n >= 9
        && chars[n - 9] == '-'
        && chars[n - 8..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
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

/// A Postgres `text[]` literal of `STATIC_ASSET_FILES`. Same contract as above.
static STATIC_ASSET_FILES_ARRAY: LazyLock<String> =
    LazyLock::new(|| routes_array(STATIC_ASSET_FILES));

/// A case-insensitive Postgres regex matching a Vite-hashed bundle name at the
/// end of the path: `-<8 base64url chars>.<ext>`, with the extension list drawn
/// from the shared constant so it can't drift from `is_hashed_bundle`.
static ASSET_BUNDLE_RE: LazyLock<String> =
    LazyLock::new(|| format!(r"-[A-Za-z0-9_-]{{8}}\.({})$", ASSET_EXTS.join("|")));

/// Bundled-asset extensions whose Vite content-hash suffix is collapsed when
/// grouping the static bucket. Vite names each build's bundle
/// `<name>-<8 chars>.<ext>` with a fresh 8-char base64url hash, so without this
/// every deploy's `index-a1B2c3D4.js` would land in its own row. Restricted to
/// the hashed code/style bundles — hashless assets (`/chip.svg`) keep their
/// exact path.
const HASH_GROUPED_EXTS: &[&str] = &["js", "mjs", "css"];

/// A SQL expression that rewrites a route's Vite content-hash suffix to a
/// literal `*`, so every build's `index-<hash>.js` groups under one
/// `index-*.js` key instead of scattering a row per deploy. `column` is the SQL
/// column (or expression) to rewrite. Any path without an 8-char hash suffix on
/// a `HASH_GROUPED_EXTS` extension is left untouched.
pub fn hash_grouped(column: &str) -> String {
    format!(
        r"regexp_replace({column}, '-[A-Za-z0-9_-]{{8}}\.({})$', '-*.\1')",
        HASH_GROUPED_EXTS.join("|")
    )
}

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

/// SQL boolean matching a genuine site asset: an exact root public file, or a
/// hash-stamped `/assets/…` bundle. Mirrors [`is_asset`], and shared by the two
/// noise predicates so they can't drift and stay exact complements. A bare
/// extension match elsewhere (`/random.js`, `/assets/jquery.js`) is deliberately
/// excluded — that's a bot probe, not a real fetch.
fn is_static_asset_sql() -> String {
    format!(
        "(route = ANY({}) OR (route LIKE '{}%' AND route ~* '{}'))",
        &*STATIC_ASSET_FILES_ARRAY,
        STATIC_ASSET_PREFIX,
        &*ASSET_BUNDLE_RE,
    )
}

/// SQL predicate for static-asset fetches: a non-page route that isn't a forced
/// robot path and points at a genuine site asset.
pub fn static_only() -> String {
    format!(
        "({}) AND NOT (route = ANY({})) AND {}",
        not_page(),
        &*ROBOT_ROUTES_ARRAY,
        is_static_asset_sql(),
    )
}

/// SQL predicate for robot/scanner noise: a non-page route that is either a
/// forced robot path or isn't a genuine site asset. The exact complement of
/// `static_only()` over non-page routes, so the two partition the noise.
pub fn robot_only() -> String {
    format!(
        "({}) AND (route = ANY({}) OR NOT {})",
        not_page(),
        &*ROBOT_ROUTES_ARRAY,
        is_static_asset_sql(),
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
    fn real_site_assets_are_static() {
        // Exact root public files.
        assert_eq!(classify(Some("/chip.svg")), VisitClass::Static);
        assert_eq!(classify(Some("/nojs-stars.png")), VisitClass::Static);
        // Hashed bundles under /assets/, case-insensitive on the extension.
        assert_eq!(
            classify(Some("/assets/index-yXm2gtty.js")),
            VisitClass::Static
        );
        assert_eq!(classify(Some("/assets/index-lOX0mMCT.CSS")), VisitClass::Static);
        // The 8-char content hash may itself contain a `-` (base64url).
        assert_eq!(
            classify(Some("/assets/apexcharts.esm-7OPUy-6j.js")),
            VisitClass::Static
        );
    }

    #[test]
    fn random_asset_looking_probes_are_robot() {
        // A matching extension at a path the site never served is a bot probe,
        // not a real fetch — it must not inflate the static count.
        assert_eq!(classify(Some("/random.js")), VisitClass::Robot);
        assert_eq!(classify(Some("/photo.jpg")), VisitClass::Robot);
        assert_eq!(classify(Some("/wp-content/themes/x.css")), VisitClass::Robot);
        // Not a real public file, even though it looks like one.
        assert_eq!(classify(Some("/favicon.ico")), VisitClass::Robot);
        // The prefix must be the real bundle dir, not just contain "assets".
        assert_eq!(classify(Some("/vendor/assets/app.js")), VisitClass::Robot);
    }

    #[test]
    fn unhashed_names_under_assets_are_robot() {
        // Under /assets/, but with no Vite content-hash suffix — a bot probing
        // for a library by name, not a real bundle fetch.
        assert_eq!(classify(Some("/assets/jquery.js")), VisitClass::Robot);
        assert_eq!(classify(Some("/assets/style.css")), VisitClass::Robot);
        // A wrong-length hash (not exactly 8 chars) doesn't qualify either.
        assert_eq!(classify(Some("/assets/index-abc123.js")), VisitClass::Robot);
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
    fn wasm_is_a_static_asset() {
        assert_eq!(classify(Some("/canvas.wasm")), VisitClass::Static);
    }

    #[test]
    fn hash_grouped_collapses_vite_bundle_hashes() {
        let expr = hash_grouped("route");
        // The Vite content-hash suffix (a `-` then 8 base64url chars) is
        // rewritten to `-*`, and the extension list is drawn from the shared
        // constant so the regex can't drift.
        assert_eq!(
            expr,
            r"regexp_replace(route, '-[A-Za-z0-9_-]{8}\.(js|mjs|css)$', '-*.\1')"
        );
    }

    #[test]
    fn dot_before_slash_is_not_an_asset() {
        // The `.js` isn't in the final segment, so it isn't an asset fetch.
        assert_eq!(classify(Some("/foo.js/bar")), VisitClass::Robot);
    }
}
