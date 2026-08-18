//! One slug algorithm for the whole codebase. Post URLs and note names both
//! depend on it, and two implementations that drift would mean a link resolving
//! in one place and 404ing in another.
//!
//! Mirrored in TypeScript by `frontend/src/notes/links.ts`, so the client can
//! resolve a `[[wikilink]]` against the loaded index without a round trip. The
//! two are pinned together by the shared fixtures in `fixtures/notes/`.

use crate::text;

/// Upper bound on a generated slug. Long enough for any real title, short
/// enough to keep URLs and index entries sane.
pub const MAX_SLUG_LEN: usize = 100;

/// Derives a slug from free text: lowercase, `[a-z0-9]` runs joined by single
/// hyphens, truncated to [`MAX_SLUG_LEN`]. May return an empty string (the
/// caller decides whether that's an error or takes a fallback).
pub fn slugify(raw: &str) -> String {
    // Byte-wise rather than char-wise: only ASCII alphanumerics are kept, and
    // every byte of a multi-byte character is `>= 0x80`, so each one is a
    // separator — and a run of separators collapses to a single hyphen. That
    // gives the same answer as decoding to chars, without the decode.
    let mut out = String::with_capacity(raw.len());
    let mut pending_hyphen = false;
    for &b in raw.as_bytes() {
        if text::is_slug_byte(b) {
            if pending_hyphen && !out.is_empty() {
                out.push('-');
            }
            pending_hyphen = false;
            out.push(b.to_ascii_lowercase() as char);
        } else {
            pending_hyphen = true;
        }
        if out.len() >= MAX_SLUG_LEN {
            break;
        }
    }
    out.truncate(MAX_SLUG_LEN);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowercases_and_joins_words() {
        assert_eq!(slugify("Deploy Pipeline"), "deploy-pipeline");
    }

    #[test]
    fn collapses_runs_of_punctuation_into_one_hyphen() {
        assert_eq!(slugify("Hello,   World!! (v2)"), "hello-world-v2");
    }

    #[test]
    fn trims_leading_and_trailing_separators() {
        assert_eq!(slugify("  --- hello ---  "), "hello");
    }

    #[test]
    fn punctuation_only_input_is_empty() {
        assert_eq!(slugify("!!!"), "");
        assert_eq!(slugify(""), "");
    }

    #[test]
    fn drops_non_ascii_rather_than_transliterating() {
        // Deliberate: a slug is an ASCII identifier. The title keeps the real
        // text; only the URL-safe key is reduced.
        assert_eq!(slugify("café über"), "caf-ber");
    }

    #[test]
    fn truncates_to_the_maximum() {
        let slug = slugify(&"a".repeat(MAX_SLUG_LEN + 50));
        assert_eq!(slug.len(), MAX_SLUG_LEN);
    }

    #[test]
    fn is_idempotent() {
        for input in ["Deploy Pipeline", "hello-world", "a  b", "!!!x!!!"] {
            let once = slugify(input);
            assert_eq!(slugify(&once), once, "not idempotent for {input:?}");
        }
    }
}
