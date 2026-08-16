//! Byte-oriented text scanning. The one place in the backend that searches,
//! splits or classifies text.
//!
//! There is no regex engine here and no regex anywhere else in the backend —
//! every pattern this codebase actually needs (find a delimiter, split a line,
//! recognise a hashed bundle name) is a handful of byte comparisons, and
//! spelling it out is both faster and easier to read than a pattern language.
//!
//! **SIMD.** The primitives below delegate to `memchr`, which dispatches to
//! AVX2/SSE2 at runtime and falls back to a word-at-a-time scan elsewhere. That
//! is deliberately preferred over hand-written intrinsics: those would need
//! `unsafe`, per-architecture code and our own feature detection to arrive at
//! the same place. `memchr` was already in the dependency tree (via sqlx), so
//! depending on it directly costs nothing to build.
//!
//! **Byte indices and UTF-8.** Every function takes an ASCII needle. A UTF-8
//! continuation byte is always `>= 0x80`, so an ASCII byte can never occur
//! inside a multi-byte character — which makes every index returned here a
//! valid `str` boundary, and the slicing safe without a char-by-char walk.

use memchr::{memchr, memmem, memrchr};

/// Debug-only guard for the invariant that keeps byte indices char-safe.
#[inline]
fn assert_ascii(byte: u8) {
    debug_assert!(byte.is_ascii(), "needle must be ASCII to stay char-boundary safe");
}

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

/// Byte index of the first `needle` in `haystack`.
///
/// Safe for any `&str` needle, ASCII or not: UTF-8 is self-synchronising, so a
/// leading byte can never appear as a continuation byte and a byte-level match
/// between two valid strings can only begin on a character boundary.
#[inline]
pub fn find(haystack: &str, needle: &str) -> Option<usize> {
    memmem::find(haystack.as_bytes(), needle.as_bytes())
}

/// Byte index of the first occurrence of an ASCII byte.
#[inline]
pub fn find_byte(haystack: &str, byte: u8) -> Option<usize> {
    assert_ascii(byte);
    memchr(byte, haystack.as_bytes())
}

/// Byte index of the last occurrence of an ASCII byte.
#[inline]
pub fn rfind_byte(haystack: &str, byte: u8) -> Option<usize> {
    assert_ascii(byte);
    memrchr(byte, haystack.as_bytes())
}

/// Splits at the first occurrence of an ASCII byte, excluding it.
#[inline]
pub fn split_once_byte(s: &str, byte: u8) -> Option<(&str, &str)> {
    let i = find_byte(s, byte)?;
    Some((&s[..i], &s[i + 1..]))
}

/// Splits at the last occurrence of an ASCII byte, excluding it.
#[inline]
pub fn rsplit_once_byte(s: &str, byte: u8) -> Option<(&str, &str)> {
    let i = rfind_byte(s, byte)?;
    Some((&s[..i], &s[i + 1..]))
}

/// The line starting at `from`, and the offset where the next one begins.
///
/// Returned line excludes its terminator and any `\r`, so callers get the same
/// answer for LF and CRLF input without normalising the whole document first.
#[inline]
pub fn line_at(text: &str, from: usize) -> (&str, usize) {
    let rest = &text[from..];
    match memchr(b'\n', rest.as_bytes()) {
        Some(i) => (rest[..i].strip_suffix('\r').unwrap_or(&rest[..i]), from + i + 1),
        None => (rest.strip_suffix('\r').unwrap_or(rest), text.len()),
    }
}

// ---------------------------------------------------------------------------
// Character classes. Byte-wise on purpose: every class here is ASCII-only, and
// a non-ASCII byte is never a member, so bytes and chars agree.
// ---------------------------------------------------------------------------

/// Kept verbatim in a slug: `[a-z0-9]` after lowercasing.
#[inline]
pub const fn is_slug_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

/// Kept verbatim in a tag: `[A-Za-z0-9_/-]`, so `infra/prod` survives.
#[inline]
pub const fn is_tag_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'/'
}

/// Legal in a frontmatter key: `[A-Za-z0-9_-]`.
#[inline]
pub const fn is_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Legal in a Vite content hash: base64url without padding.
#[inline]
pub const fn is_hash_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// True when every byte satisfies `class`.
#[inline]
pub fn all_bytes(s: &str, class: fn(u8) -> bool) -> bool {
    s.as_bytes().iter().copied().all(class)
}

// ---------------------------------------------------------------------------
// Shared shapes.
// ---------------------------------------------------------------------------

/// Length of a Vite content hash: `name-a1B2c3D4.js`.
pub const HASH_LEN: usize = 8;

/// Splits a filename stem at its Vite content-hash suffix, returning the part
/// before the `-`.
///
/// `index-a1B2c3D4` → `Some("index")`; anything else → `None`. Used both to
/// classify a request and to collapse per-deploy bundle names into one key, so
/// the two can't disagree about what a hash looks like.
pub fn strip_hash_suffix(stem: &str) -> Option<&str> {
    let bytes = stem.as_bytes();
    // `-` plus exactly HASH_LEN hash characters.
    let cut = bytes.len().checked_sub(HASH_LEN + 1)?;
    if bytes[cut] != b'-' {
        return None;
    }
    if !bytes[cut + 1..].iter().copied().all(is_hash_byte) {
        return None;
    }
    Some(&stem[..cut])
}

/// The final `/`-separated segment of a path.
#[inline]
pub fn last_segment(path: &str) -> &str {
    match rfind_byte(path, b'/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Splits a filename into `(stem, extension)` at the last `.`.
#[inline]
pub fn split_extension(name: &str) -> Option<(&str, &str)> {
    rsplit_once_byte(name, b'.')
}

/// Percent-decodes nothing and allocates nothing: the value of `key` in a
/// `a=1&b=2` query string, still encoded.
pub fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = query;
    loop {
        let (pair, next) = match find_byte(rest, b'&') {
            Some(i) => (&rest[..i], Some(&rest[i + 1..])),
            None => (rest, None),
        };
        if let Some((k, v)) = split_once_byte(pair, b'=') && k == key {
            return Some(v);
        }
        match next {
            Some(n) => rest = n,
            None => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_locates_substrings() {
        assert_eq!(find("hello world", "world"), Some(6));
        assert_eq!(find("hello", "zzz"), None);
    }

    #[test]
    fn byte_search_both_directions() {
        assert_eq!(find_byte("a:b:c", b':'), Some(1));
        assert_eq!(rfind_byte("a:b:c", b':'), Some(3));
        assert_eq!(find_byte("abc", b':'), None);
    }

    #[test]
    fn split_once_byte_excludes_the_delimiter() {
        assert_eq!(split_once_byte("key: value", b':'), Some(("key", " value")));
        assert_eq!(rsplit_once_byte("a.b.c", b'.'), Some(("a.b", "c")));
        assert_eq!(split_once_byte("nope", b':'), None);
    }

    #[test]
    fn find_handles_a_non_ascii_needle() {
        let s = "a café here";
        let i = find(s, "café").unwrap();
        assert_eq!(&s[i..i + "café".len()], "café");
    }

    #[test]
    fn ascii_indices_are_char_safe_in_utf8() {
        // The delimiter sits after a multi-byte character; slicing at the
        // returned index must not split it.
        let s = "café:über";
        let (a, b) = split_once_byte(s, b':').unwrap();
        assert_eq!(a, "café");
        assert_eq!(b, "über");
    }

    #[test]
    fn line_at_walks_lf_and_crlf() {
        let text = "one\r\ntwo\nthree";
        let (l1, n1) = line_at(text, 0);
        assert_eq!(l1, "one");
        let (l2, n2) = line_at(text, n1);
        assert_eq!(l2, "two");
        let (l3, n3) = line_at(text, n2);
        assert_eq!(l3, "three");
        assert_eq!(n3, text.len());
    }

    #[test]
    fn line_at_handles_a_trailing_newline() {
        let (line, next) = line_at("only\n", 0);
        assert_eq!(line, "only");
        assert_eq!(next, 5);
    }

    #[test]
    fn strip_hash_suffix_recognises_vite_names() {
        assert_eq!(strip_hash_suffix("index-a1B2c3D4"), Some("index"));
        assert_eq!(strip_hash_suffix("secret_notes-EhLO8GyQ"), Some("secret_notes"));
        // Seven characters is not a hash.
        assert_eq!(strip_hash_suffix("index-a1B2c3D"), None);
        // Nine is not either.
        assert_eq!(strip_hash_suffix("index-a1B2c3D4e"), None);
        assert_eq!(strip_hash_suffix("index"), None);
        assert_eq!(strip_hash_suffix(""), None);
        // A dot is not a hash character.
        assert_eq!(strip_hash_suffix("index-a1B2c3.4"), None);
    }

    #[test]
    fn path_and_extension_helpers() {
        assert_eq!(last_segment("/assets/index.js"), "index.js");
        assert_eq!(last_segment("index.js"), "index.js");
        assert_eq!(split_extension("index.js"), Some(("index", "js")));
        assert_eq!(split_extension("noext"), None);
        assert_eq!(split_extension("a.b.c"), Some(("a.b", "c")));
    }

    #[test]
    fn query_value_reads_pairs() {
        assert_eq!(query_value("a=1&b=2", "b"), Some("2"));
        assert_eq!(query_value("a=1", "a"), Some("1"));
        assert_eq!(query_value("a=1&b=2", "c"), None);
        assert_eq!(query_value("", "a"), None);
        assert_eq!(query_value("flag&a=1", "a"), Some("1"));
        // First wins, matching the previous behaviour.
        assert_eq!(query_value("a=1&a=2", "a"), Some("1"));
    }

    #[test]
    fn character_classes() {
        assert!(is_tag_byte(b'/'));
        assert!(!is_slug_byte(b'/'));
        assert!(is_key_byte(b'-'));
        assert!(!is_key_byte(b'/'));
        assert!(all_bytes("abc-1", is_key_byte));
        assert!(!all_bytes("abc 1", is_key_byte));
    }
}
