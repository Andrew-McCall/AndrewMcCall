//! Everything the index knows about a note, derived from its text.
//!
//! This module is pure: text in, [`Derived`] out. All the interesting rules
//! live here and are unit-tested without a database, which is what lets the
//! boot reindexer re-run them over the whole vault with confidence.

use crate::slug::slugify;
use crate::text;

use super::frontmatter;

/// Longest accepted tag. Beyond this the tag is dropped with a notice, never an
/// error — an index problem must not block someone saving their writing.
pub const MAX_TAG_LEN: usize = 50;

/// Frontmatter keys with dedicated storage, so they never land in `note_udf`.
/// `title` is excluded because `notes.title` already caches it, and storing the
/// same fact twice is how the two drift.
const RESERVED_KEYS: [&str; 3] = ["title", "tags", "aliases"];

const DEFAULT_TITLE: &str = "Untitled";

/// A non-fatal problem found while deriving. Surfaced to the editor's status
/// line so a silently-unindexed tag is visible rather than mysterious.
pub type Notice = String;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Derived {
    pub title: String,
    /// Slug for the note's primary name. Empty when the title has no
    /// slug-able characters; the caller substitutes a fallback.
    pub primary: String,
    /// Alias slugs, de-duplicated and excluding the primary.
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    /// Every other frontmatter key, one entry per value.
    pub udf: Vec<(String, String)>,
    /// Slugs of `[[wikilink]]` targets, de-duplicated.
    pub links: Vec<String>,
    pub notices: Vec<Notice>,
}

/// Blanks out fenced blocks and inline code, preserving the **line structure**
/// so the result can be scanned line-for-line against the original.
///
/// This is how `[[note]]` in a code sample stays a code sample.
///
/// Byte offsets are **not** preserved: a blanked multi-byte character becomes a
/// single-byte space, so an index into the mask must never be used to slice the
/// original. Line indices are safe, and that is what `first_heading` relies on.
fn mask_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_fence = false;

    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let tail = &line[body.len()..];

        if body.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.extend(std::iter::repeat_n(' ', body.chars().count()));
            out.push_str(tail);
            continue;
        }
        if in_fence {
            out.extend(std::iter::repeat_n(' ', body.chars().count()));
            out.push_str(tail);
            continue;
        }

        // Inline code: blank the span including its backticks.
        let mut masked = String::with_capacity(body.len());
        let mut in_code = false;
        for c in body.chars() {
            if c == '`' {
                in_code = !in_code;
                masked.push(' ');
            } else if in_code {
                masked.push(' ');
            } else {
                masked.push(c);
            }
        }
        out.push_str(&masked);
        out.push_str(tail);
    }
    out
}

/// Normalizes a tag to `[A-Za-z0-9_/-]`, preserving case. Internal whitespace
/// becomes a hyphen so `foo bar` indexes as `foo-bar` rather than vanishing.
/// Returns `None` when nothing usable is left.
pub fn clean_tag(raw: &str) -> Option<String> {
    // Byte-wise for the same reason as `slugify`: the accepted set is ASCII, so
    // every byte of a multi-byte character is a separator and collapses.
    let mut out = String::with_capacity(raw.len());
    let mut pending = false;
    for &b in raw.trim().as_bytes() {
        if text::is_tag_byte(b) {
            if pending && !out.is_empty() {
                out.push('-');
            }
            pending = false;
            out.push(b as char);
        } else {
            pending = true;
        }
    }
    // Trim separators that ended up on the edges, and collapse `//`.
    let out = out.trim_matches(['-', '/']).to_string();
    if out.is_empty() || out.len() > MAX_TAG_LEN {
        return None;
    }
    Some(out)
}

/// The first `# heading` in the content, ignoring anything inside a fence.
///
/// The masked text decides *which* line is a heading; the text comes from the
/// original. Reading it from the mask instead would blank any inline code in
/// the heading — `# The \`derive\` function` became `The          function`,
/// which then became the note's slug too.
fn first_heading(content: &str, masked: &str) -> Option<String> {
    // `mask_code` rewrites each line in place, so the two iterate in lockstep.
    content
        .lines()
        .zip(masked.lines())
        .find(|(_, masked_line)| masked_line.starts_with("# "))
        .map(|(line, _)| line[2..].trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Extracts `[[target]]` slugs. Handles `[[a|label]]` and `[[a#heading]]`, and
/// skips `[[#local]]`, which points within the current note.
fn extract_links(masked_content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = masked_content;
    // SIMD substring search jumps straight to each `[[` instead of testing
    // every byte, which matters because most of a note is prose between links.
    while let Some(open) = text::find(rest, "[[") {
        let after = &rest[open + 2..];
        let Some(close) = text::find(after, "]]") else {
            break; // unterminated: nothing further can be a link
        };
        let inner = &after[..close];
        // `target|label` and `target#heading` may combine: strip the label
        // first, then the fragment. `[[#Heading]]` leaves nothing, which is
        // right — it points within the current note.
        let before_label = inner.split_once('|').map_or(inner, |(t, _)| t);
        let target = before_label
            .split_once('#')
            .map_or(before_label, |(t, _)| t)
            .trim();
        if !target.is_empty() {
            let slug = slugify(target);
            if !slug.is_empty() && !out.contains(&slug) {
                out.push(slug);
            }
        }
        rest = &after[close + 2..];
    }
    out
}

/// Derives the full index entry for a note body.
pub fn derive(body: &str) -> Derived {
    let fm = frontmatter::parse(body);
    let content = frontmatter::content_of(body, &fm);
    let masked = mask_code(content);
    let mut notices = Vec::new();

    let title = fm
        .first("title")
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or_else(|| first_heading(content, &masked))
        .unwrap_or_else(|| DEFAULT_TITLE.to_string());

    let primary = slugify(&title);

    let mut aliases: Vec<String> = Vec::new();
    for raw in fm.get("aliases") {
        let slug = slugify(raw);
        if slug.is_empty() {
            notices.push(format!("alias {raw:?} has no usable characters — skipped"));
            continue;
        }
        if slug != primary && !aliases.contains(&slug) {
            aliases.push(slug);
        }
    }

    let mut tags: Vec<String> = Vec::new();
    for raw in fm.get("tags") {
        match clean_tag(raw) {
            Some(tag) => {
                if raw != &tag {
                    notices.push(format!("tag {raw:?} indexed as {tag:?}"));
                }
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
            None => notices.push(format!("tag {raw:?} is not a usable tag — skipped")),
        }
    }

    let mut udf: Vec<(String, String)> = Vec::new();
    for (key, values) in fm.iter() {
        if RESERVED_KEYS.contains(&key) {
            continue;
        }
        for value in values {
            let entry = (key.to_string(), value.clone());
            if !udf.contains(&entry) {
                udf.push(entry);
            }
        }
    }

    Derived {
        title,
        primary,
        aliases,
        tags,
        udf,
        links: extract_links(&masked),
        notices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_heading_title_keeps_its_inline_code() {
        // Regression: the title used to be read from the code-masked text, so
        // this became "The          function" and the slug "the-function".
        let d = derive("# The `derive` function\n");
        assert_eq!(d.title, "The `derive` function");
        assert_eq!(d.primary, "the-derive-function");
    }

    #[test]
    fn a_heading_title_still_ignores_fenced_code() {
        let d = derive("```sh\n# not a title\n```\n\n# The `real` one\n");
        assert_eq!(d.title, "The `real` one");
    }

    #[test]
    fn title_prefers_frontmatter() {
        let d = derive("---\ntitle: From Meta\n---\n# From Heading\n");
        assert_eq!(d.title, "From Meta");
        assert_eq!(d.primary, "from-meta");
    }

    #[test]
    fn title_falls_back_to_the_first_h1() {
        let d = derive("---\ntags: [a]\n---\n\n# From Heading\n\ntext\n");
        assert_eq!(d.title, "From Heading");
    }

    #[test]
    fn title_falls_back_to_untitled() {
        assert_eq!(derive("just some prose").title, "Untitled");
    }

    #[test]
    fn a_heading_inside_a_fence_is_not_the_title() {
        let d = derive("```sh\n# not a title\n```\n\n# Real Title\n");
        assert_eq!(d.title, "Real Title");
    }

    #[test]
    fn tags_come_from_every_list_form() {
        assert_eq!(derive("---\ntags: [a, b]\n---\n").tags, ["a", "b"]);
        assert_eq!(derive("---\ntags:\n  - a\n  - b\n---\n").tags, ["a", "b"]);
        assert_eq!(derive("---\ntags: solo\n---\n").tags, ["solo"]);
    }

    #[test]
    fn nested_tags_keep_their_slashes_and_case() {
        assert_eq!(derive("---\ntags: [Infra/Prod]\n---\n").tags, ["Infra/Prod"]);
    }

    #[test]
    fn tags_are_deduplicated() {
        assert_eq!(derive("---\ntags: [a, a, b]\n---\n").tags, ["a", "b"]);
    }

    #[test]
    fn an_unusable_tag_is_dropped_with_a_notice_not_an_error() {
        let d = derive("---\ntags: [\"!!!\", ok]\n---\n");
        assert_eq!(d.tags, ["ok"]);
        assert_eq!(d.notices.len(), 1);
    }

    #[test]
    fn a_tag_with_a_space_is_normalized_and_reported() {
        let d = derive("---\ntags: [foo bar]\n---\n");
        assert_eq!(d.tags, ["foo-bar"]);
        assert!(d.notices[0].contains("indexed as"));
    }

    #[test]
    fn an_overlong_tag_is_dropped() {
        let long = "a".repeat(MAX_TAG_LEN + 1);
        let d = derive(&format!("---\ntags: [{long}]\n---\n"));
        assert!(d.tags.is_empty());
    }

    #[test]
    fn aliases_are_slugified_and_exclude_the_primary() {
        let d = derive("---\ntitle: Deploy Pipeline\naliases:\n  - Deploy Notes\n  - Deploy Pipeline\n---\n");
        assert_eq!(d.primary, "deploy-pipeline");
        assert_eq!(d.aliases, ["deploy-notes"]);
    }

    #[test]
    fn unknown_keys_become_udf_entries_one_per_value() {
        let d = derive("---\ntitle: T\nclient: acme\nprojects: [a, b]\n---\n");
        assert_eq!(
            d.udf,
            [
                ("client".to_string(), "acme".to_string()),
                ("projects".to_string(), "a".to_string()),
                ("projects".to_string(), "b".to_string()),
            ]
        );
    }

    #[test]
    fn reserved_keys_never_reach_udf() {
        let d = derive("---\ntitle: T\ntags: [x]\naliases: [y]\n---\n");
        assert!(d.udf.is_empty());
    }

    #[test]
    fn a_mistyped_key_lands_in_udf_where_it_is_visible() {
        // `tag:` rather than `tags:` — the whole point of the UDF catch-all.
        let d = derive("---\ntag: infra\n---\n");
        assert!(d.tags.is_empty());
        assert_eq!(d.udf, [("tag".to_string(), "infra".to_string())]);
    }

    #[test]
    fn extracts_wikilinks_in_every_form() {
        let d = derive("see [[Backend]], [[Runbook|the runbook]] and [[Notes#Section]]");
        assert_eq!(d.links, ["backend", "runbook", "notes"]);
    }

    #[test]
    fn ignores_a_link_to_a_heading_in_this_note() {
        assert!(derive("jump to [[#Section]]").links.is_empty());
    }

    #[test]
    fn deduplicates_links() {
        assert_eq!(derive("[[a]] [[A]] [[a|x]]").links, ["a"]);
    }

    #[test]
    fn does_not_extract_links_from_a_fenced_block() {
        assert!(derive("```\n[[backend]]\n```\n").links.is_empty());
    }

    #[test]
    fn does_not_extract_links_from_inline_code() {
        assert!(derive("use `[[backend]]` here").links.is_empty());
    }

    #[test]
    fn extracts_links_around_code() {
        let d = derive("[[one]] `[[skipped]]` [[two]]\n```\n[[nope]]\n```\n[[three]]");
        assert_eq!(d.links, ["one", "two", "three"]);
    }

    #[test]
    fn frontmatter_is_not_scanned_for_links() {
        assert!(derive("---\ntitle: [[not a link]]\n---\n").links.is_empty());
    }

    #[test]
    fn unterminated_wikilink_is_ignored() {
        assert!(derive("[[dangling").links.is_empty());
    }

    #[test]
    fn derive_is_idempotent_over_its_own_output() {
        let body = "---\ntitle: Deploy Pipeline\ntags:\n  - infra\naliases:\n  - old-name\n---\n\nSee [[Backend]].\n";
        let first = derive(body);
        let second = derive(body);
        assert_eq!(first, second);
    }

    #[test]
    fn mask_code_preserves_line_count() {
        let text = "a\n```\nb\n```\nc\n";
        assert_eq!(mask_code(text).lines().count(), text.lines().count());
    }
}
