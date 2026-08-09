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
//! visits from asset fetches and bot noise.
//!
//! [`classify`] is the only definition of these rules. The `/stats` aggregates
//! used to repeat them as SQL — including a Postgres regex for hashed bundle
//! names — which meant two implementations and a comment on each asking the
//! reader to keep them in step. Now SQL only narrows to non-page rows and
//! [`split_noise`] does the classifying, so there is nothing to drift.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::text;

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
pub const STATIC_ASSET_FILES: &[&str] = &[
    "/canvas.wasm",
    "/chip.svg",
    "/nojs.png",
    "/nojs-stars.png",
    "/favicon.ico",
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
/// extension.
fn is_hashed_bundle(route: &str) -> bool {
    let Some((stem, ext)) = text::split_extension(text::last_segment(route)) else {
        return false;
    };
    ASSET_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e))
        && text::strip_hash_suffix(stem).is_some()
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

// `ROBOT_ROUTES` and `STATIC_ASSET_FILES` no longer need SQL array literals:
// only `VALID_ROUTES` is used to narrow rows in the query, and everything
// finer-grained is decided by `classify` in `split_noise`.

/// Bundled-asset extensions whose Vite content-hash suffix is collapsed when
/// grouping the static bucket. Vite names each build's bundle
/// `<name>-<8 chars>.<ext>` with a fresh 8-char base64url hash, so without this
/// every deploy's `index-a1B2c3D4.js` would land in its own row. Restricted to
/// the hashed code/style bundles — hashless assets (`/chip.svg`) keep their
/// exact path.
const HASH_GROUPED_EXTS: &[&str] = &["js", "mjs", "css"];

/// Rewrites a route's Vite content-hash suffix to a literal `*`, so every
/// build's `index-<hash>.js` groups under one `index-*.js` key instead of
/// scattering a row per deploy. Any path without an 8-character hash suffix on
/// a [`HASH_GROUPED_EXTS`] extension is returned untouched, and borrowed — the
/// common case allocates nothing.
pub fn hash_collapsed(route: &str) -> Cow<'_, str> {
    let segment = text::last_segment(route);
    let Some((stem, ext)) = text::split_extension(segment) else {
        return Cow::Borrowed(route);
    };
    if !HASH_GROUPED_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
        return Cow::Borrowed(route);
    }
    let Some(base) = text::strip_hash_suffix(stem) else {
        return Cow::Borrowed(route);
    };
    let dir = &route[..route.len() - segment.len()];
    Cow::Owned(format!("{dir}{base}-*.{ext}"))
}

/// The two noise buckets, folded out of one grouped query.
#[derive(Default)]
pub struct Noise {
    pub static_total: i64,
    pub static_routes: Vec<(String, i64)>,
    pub robot_total: i64,
    pub robot_routes: Vec<(String, i64)>,
}

/// Splits raw `(route, count)` rows into the static and robot buckets, folding
/// each build's hashed bundle names together.
///
/// Classification lives here rather than in SQL so [`classify`] is the single
/// definition of what a bot probe is — previously the same rules existed twice,
/// once in Rust and once as a Postgres regex, with a comment on each asking the
/// reader to keep them in step.
pub fn split_noise(rows: impl IntoIterator<Item = (String, i64)>, limit: usize) -> Noise {
    let mut statics: HashMap<String, i64> = HashMap::new();
    let mut robots: HashMap<String, i64> = HashMap::new();
    let mut out = Noise::default();

    for (route, count) in rows {
        match classify(Some(&route)) {
            VisitClass::Page => continue, // filtered in SQL; belt and braces
            VisitClass::Static => {
                out.static_total += count;
                *statics.entry(hash_collapsed(&route).into_owned()).or_default() += count;
            }
            VisitClass::Robot => {
                out.robot_total += count;
                *robots.entry(route).or_default() += count;
            }
        }
    }

    // Busiest first, then by route so equal counts are stably ordered — the
    // same ordering the SQL `ORDER BY COUNT(*) DESC, route` produced.
    let rank = |mut v: Vec<(String, i64)>| {
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v.truncate(limit);
        v
    };
    out.static_routes = rank(statics.into_iter().collect());
    out.robot_routes = rank(robots.into_iter().collect());
    out
}

/// SQL predicate for everything the two noise buckets cover: a real, non-page
/// route. Which bucket each row lands in is decided by [`split_noise`].
pub fn noise_only() -> String {
    not_page()
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
        assert_eq!(classify(Some("/favicon.ico")), VisitClass::Static);
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
        assert_eq!(classify(Some("/apple-touch-icon.png")), VisitClass::Robot);
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
    fn hash_collapsed_folds_vite_bundle_hashes() {
        assert_eq!(hash_collapsed("/assets/index-a1B2c3D4.js"), "/assets/index-*.js");
        assert_eq!(hash_collapsed("/assets/style-Zz_9-Yx8.css"), "/assets/style-*.css");
        assert_eq!(hash_collapsed("/assets/app-a1B2c3D4.mjs"), "/assets/app-*.mjs");
    }

    #[test]
    fn hash_collapsed_leaves_everything_else_alone() {
        for route in [
            "/chip.svg",                     // not a grouped extension
            "/canvas.wasm",                  // not a grouped extension
            "/assets/jquery.js",             // no hash suffix
            "/assets/index-short.js",        // hash too short
            "/assets/index-a1B2c3D4e.js",    // hash too long
            "/posts/some-slug",              // no extension
            "",
        ] {
            assert_eq!(hash_collapsed(route), route, "changed {route:?}");
        }
    }

    #[test]
    fn hash_collapsed_borrows_when_unchanged() {
        // The common case must not allocate.
        assert!(matches!(hash_collapsed("/posts/x"), Cow::Borrowed(_)));
        assert!(matches!(hash_collapsed("/assets/a-a1B2c3D4.js"), Cow::Owned(_)));
    }

    #[test]
    fn split_noise_partitions_and_folds() {
        let rows = vec![
            ("/assets/index-a1B2c3D4.js".to_string(), 3),
            ("/assets/index-Zz_9-Yx8.js".to_string(), 4), // same bundle, later build
            ("/chip.svg".to_string(), 2),
            ("/wp-login.php".to_string(), 9),
            ("/robots.txt".to_string(), 1), // forced robot path
        ];
        let noise = split_noise(rows, 10);

        // Both builds of the bundle fold into one row.
        assert_eq!(noise.static_total, 9);
        assert_eq!(
            noise.static_routes,
            vec![("/assets/index-*.js".to_string(), 7), ("/chip.svg".to_string(), 2)]
        );

        assert_eq!(noise.robot_total, 10);
        assert_eq!(
            noise.robot_routes,
            vec![("/wp-login.php".to_string(), 9), ("/robots.txt".to_string(), 1)]
        );
    }

    #[test]
    fn split_noise_orders_by_count_then_route_and_limits() {
        let rows = vec![
            ("/b.php".to_string(), 5),
            ("/a.php".to_string(), 5), // tie broken by route
            ("/c.php".to_string(), 9),
        ];
        let noise = split_noise(rows, 2);
        assert_eq!(
            noise.robot_routes,
            vec![("/c.php".to_string(), 9), ("/a.php".to_string(), 5)]
        );
        // The total counts every row, not just the ones that survived the limit.
        assert_eq!(noise.robot_total, 19);
    }

    #[test]
    fn split_noise_matches_classify_for_every_route() {
        // The buckets are exactly what `classify` says, which is the property
        // the old SQL predicates had to reimplement by hand.
        let routes = [
            "/assets/index-a1B2c3D4.js",
            "/assets/jquery.js",
            "/chip.svg",
            "/random.js",
            "/wp-login.php",
            "/sitemap.xml",
        ];
        let noise = split_noise(routes.iter().map(|r| (r.to_string(), 1)), 100);
        let expected_static = routes
            .iter()
            .filter(|r| classify(Some(r)) == VisitClass::Static)
            .count() as i64;
        assert_eq!(noise.static_total, expected_static);
        assert_eq!(noise.robot_total, routes.len() as i64 - expected_static);
    }

    #[test]
    fn dot_before_slash_is_not_an_asset() {
        // The `.js` isn't in the final segment, so it isn't an asset fetch.
        assert_eq!(classify(Some("/foo.js/bar")), VisitClass::Robot);
    }
}
