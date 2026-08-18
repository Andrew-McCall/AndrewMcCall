//! The `---` block at the top of a note: a deliberately small, strict subset of
//! YAML rather than the real thing.
//!
//! ```text
//! key: value                 scalar, raw text to end of line, trimmed
//! key: [a, b, c]             inline list
//! key:                       block list
//!   - a
//!   - b
//! key:                       empty → no values
//! ```
//!
//! Rules that matter:
//!
//! * The block exists only when the **first** line is exactly `---`, closed by
//!   the next line that is exactly `---`. A leading `---` used as a horizontal
//!   rule is therefore only misread if a second one follows, which is the same
//!   ambiguity every markdown tool has.
//! * A malformed block is **never an error**. It degrades to "this note has no
//!   frontmatter" and the text renders as written, so no note can become
//!   unopenable because of a stray colon.
//! * Unknown keys are preserved verbatim — this parser never rewrites text it
//!   wasn't explicitly asked to patch.
//!
//! Mirrored in `frontend/src/notes/frontmatter.ts`; the two are pinned together
//! by `fixtures/notes/`.

use crate::text as txt;

/// A parsed frontmatter block. Entries keep source order, which is what lets a
/// patch put a new key in a predictable place.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Frontmatter {
    entries: Vec<(String, Vec<String>)>,
    /// Byte offset in the original text where the content after the block
    /// begins. Zero when there was no block.
    pub content_start: usize,
}

/// Strips one matched pair of surrounding quotes, if present.
fn unquote(raw: &str) -> &str {
    let t = raw.trim();
    for q in ['"', '\''] {
        if t.len() >= 2 && t.starts_with(q) && t.ends_with(q) {
            return &t[1..t.len() - 1];
        }
    }
    t
}

fn is_key(s: &str) -> bool {
    !s.is_empty() && txt::all_bytes(s, txt::is_key_byte)
}

/// Splits an inline `[a, b, c]` list. Empty entries are dropped.
fn inline_list(raw: &str) -> Vec<String> {
    raw.trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|v| unquote(v).to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

impl Frontmatter {
    /// All values for `key`, or an empty slice. A scalar is a one-element slice,
    /// so callers don't need to care which form was written.
    pub fn get(&self, key: &str) -> &[String] {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_slice())
            .unwrap_or(&[])
    }

    /// The single value for `key`, or `None` when absent or empty.
    pub fn first(&self, key: &str) -> Option<&str> {
        self.get(key).first().map(|s| s.as_str())
    }

    /// Every entry, in source order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &[String])> {
        self.entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
    }

    /// Whether the block carried no entries. Only the parser tests ask this —
    /// nothing in the serving path branches on it — so it is compiled out of
    /// the binary rather than carried as dead weight.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Parses the block at the top of `text`. Always succeeds: a document with no
/// block, or a malformed one, yields an empty [`Frontmatter`] with
/// `content_start == 0`.
pub fn parse(text: &str) -> Frontmatter {
    let normalized_first_line = text.split('\n').next().unwrap_or("").trim_end_matches('\r');
    if normalized_first_line.trim_end() != "---" {
        return Frontmatter::default();
    }

    // Walk lines, tracking byte offsets so `content_start` can slice the
    // original text without re-joining anything.
    let mut offset = normalized_first_line.len();
    if text[offset..].starts_with('\r') {
        offset += 1;
    }
    if text[offset..].starts_with('\n') {
        offset += 1;
    }

    let mut entries: Vec<(String, Vec<String>)> = Vec::new();
    let mut pending_key: Option<String> = None;
    let mut closed = false;

    while offset < text.len() {
        let (line, next) = txt::line_at(text, offset);

        if line.trim_end() == "---" {
            offset = next;
            closed = true;
            break;
        }

        // A `  - value` continuation belongs to the key above it.
        if let Some(item) = line.trim_start().strip_prefix("- ") {
            if let Some(key) = &pending_key {
                let value = unquote(item).to_string();
                if !value.is_empty()
                    && let Some((_, values)) = entries.iter_mut().find(|(k, _)| k == key)
                {
                    values.push(value);
                }
            }
            offset = next;
            continue;
        }

        if let Some((raw_key, raw_value)) = line.split_once(':') {
            let key = raw_key.trim().to_ascii_lowercase();
            if is_key(&key) {
                let raw_value = raw_value.trim();
                let values = if raw_value.is_empty() {
                    Vec::new()
                } else if raw_value.starts_with('[') {
                    inline_list(raw_value)
                } else {
                    vec![unquote(raw_value).to_string()]
                };
                // Last wins, and the entry keeps its original position.
                if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
                    slot.1 = values;
                } else {
                    entries.push((key.clone(), values));
                }
                pending_key = Some(key);
                offset = next;
                continue;
            }
        }

        // Anything else inside the block (blank line, stray text) is skipped
        // rather than aborting the parse.
        pending_key = None;
        offset = next;
    }

    if !closed {
        // No terminator: this was never a frontmatter block. Treat the whole
        // document as content so nothing is swallowed.
        return Frontmatter::default();
    }

    Frontmatter {
        entries,
        content_start: offset,
    }
}

/// The document text after the frontmatter block.
pub fn content_of<'a>(text: &'a str, fm: &Frontmatter) -> &'a str {
    &text[fm.content_start.min(text.len())..]
}

/// Serializes one entry. Lists always use the block form: it needs no escaping,
/// so a value containing a comma or a bracket can never corrupt the document.
fn render_entry(key: &str, values: &[String]) -> String {
    match values {
        [] => format!("{key}:\n"),
        [one] => format!("{key}: {}\n", one.replace(['\n', '\r'], " ")),
        many => {
            let mut out = format!("{key}:\n");
            for v in many {
                out.push_str(&format!("  - {}\n", v.replace(['\n', '\r'], " ")));
            }
            out
        }
    }
}

/// Rewrites a single list-valued key, leaving every other line — including
/// unknown keys, ordering and spacing — exactly as it was.
///
/// This is the only function that edits a note's text, and it is deliberately
/// the narrowest possible edit: the GUI can manage `tags:` and `aliases:`
/// without ever round-tripping the whole block through a serializer.
///
/// Passing an empty `values` removes the key.
pub fn patch_list(text: &str, key: &str, values: &[String]) -> String {
    let key = key.to_ascii_lowercase();
    let fm = parse(text);

    // No block at all: build one, unless there's nothing to write.
    if fm.content_start == 0 {
        if values.is_empty() {
            return text.to_string();
        }
        let separator = if text.is_empty() { "" } else { "\n" };
        return format!("---\n{}---\n{separator}{text}", render_entry(&key, values));
    }

    let (block, content) = text.split_at(fm.content_start);
    let mut out = String::with_capacity(text.len() + 32);
    let mut replaced = false;
    let mut skipping = false;

    for line in block.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);

        // Drop the continuation lines of the key being replaced.
        if skipping {
            if trimmed.trim_start().starts_with("- ") {
                continue;
            }
            skipping = false;
        }

        let is_target = trimmed
            .split_once(':')
            .is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case(&key));

        if is_target && !replaced {
            replaced = true;
            skipping = true;
            if !values.is_empty() {
                out.push_str(&render_entry(&key, values));
            }
            continue;
        }

        // Insert before the closing `---` if the key wasn't already present.
        if trimmed.trim_end() == "---" && !replaced && !out.is_empty() {
            replaced = true;
            if !values.is_empty() {
                out.push_str(&render_entry(&key, values));
            }
        }

        out.push_str(line);
    }

    out.push_str(content);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scalar_inline_list_and_block_list() {
        let fm = parse("---\ntitle: Deploy\ntags: [a, b]\naliases:\n  - x\n  - y\n---\nbody");
        assert_eq!(fm.first("title"), Some("Deploy"));
        assert_eq!(fm.get("tags"), ["a".to_string(), "b".to_string()]);
        assert_eq!(fm.get("aliases"), ["x".to_string(), "y".to_string()]);
    }

    #[test]
    fn content_starts_after_the_block() {
        let text = "---\ntitle: T\n---\nreal body\n";
        let fm = parse(text);
        assert_eq!(content_of(text, &fm), "real body\n");
    }

    #[test]
    fn no_block_leaves_the_whole_document_as_content() {
        let text = "# Just a heading\n";
        let fm = parse(text);
        assert!(fm.is_empty());
        assert_eq!(content_of(text, &fm), text);
    }

    #[test]
    fn a_leading_horizontal_rule_is_not_frontmatter() {
        // No closing `---`, so this is a rule, not a block.
        let text = "---\njust prose\n";
        assert!(parse(text).is_empty());
        assert_eq!(content_of(text, &parse(text)), text);
    }

    #[test]
    fn handles_crlf() {
        let fm = parse("---\r\ntitle: T\r\ntags: [a]\r\n---\r\nbody");
        assert_eq!(fm.first("title"), Some("T"));
        assert_eq!(fm.get("tags"), ["a".to_string()]);
    }

    #[test]
    fn colon_inside_a_value_is_kept() {
        let fm = parse("---\ntitle: Ratio 3:1 — a study\n---\n");
        assert_eq!(fm.first("title"), Some("Ratio 3:1 — a study"));
    }

    #[test]
    fn duplicate_key_last_wins_keeping_position() {
        let fm = parse("---\ntitle: first\ntags: [x]\ntitle: second\n---\n");
        assert_eq!(fm.first("title"), Some("second"));
        let keys: Vec<_> = fm.iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["title", "tags"]);
    }

    #[test]
    fn keys_are_lowercased_and_values_unquoted() {
        let fm = parse("---\nTitle: \"Quoted\"\nCLIENT: 'acme'\n---\n");
        assert_eq!(fm.first("title"), Some("Quoted"));
        assert_eq!(fm.first("client"), Some("acme"));
    }

    #[test]
    fn empty_value_yields_no_values() {
        let fm = parse("---\ntags:\n---\n");
        assert!(fm.get("tags").is_empty());
    }

    #[test]
    fn junk_lines_are_skipped_not_fatal() {
        let fm = parse("---\nnot a key line\ntitle: T\n!!bad!!: x\n---\n");
        assert_eq!(fm.first("title"), Some("T"));
        assert_eq!(fm.first("!!bad!!"), None);
    }

    #[test]
    fn unknown_keys_are_preserved() {
        let fm = parse("---\nclient: acme\nproject: apollo\n---\n");
        assert_eq!(fm.first("client"), Some("acme"));
        assert_eq!(fm.first("project"), Some("apollo"));
    }

    #[test]
    fn patch_replaces_a_scalar_with_a_list() {
        let out = patch_list("---\ntitle: T\ntags: old\n---\nbody", "tags", &[
            "a".to_string(),
            "b".to_string(),
        ]);
        assert_eq!(out, "---\ntitle: T\ntags:\n  - a\n  - b\n---\nbody");
    }

    #[test]
    fn patch_replaces_a_block_list_dropping_old_items() {
        let out = patch_list(
            "---\ntags:\n  - old1\n  - old2\nclient: acme\n---\nbody",
            "tags",
            &["new".to_string()],
        );
        assert_eq!(out, "---\ntags: new\nclient: acme\n---\nbody");
    }

    #[test]
    fn patch_inserts_a_missing_key_before_the_terminator() {
        let out = patch_list("---\ntitle: T\n---\nbody", "tags", &["a".to_string()]);
        assert_eq!(out, "---\ntitle: T\ntags: a\n---\nbody");
    }

    #[test]
    fn patch_creates_a_block_when_there_is_none() {
        let out = patch_list("# Heading\n", "tags", &["a".to_string()]);
        assert_eq!(out, "---\ntags: a\n---\n\n# Heading\n");
    }

    #[test]
    fn patch_with_no_values_removes_the_key() {
        let out = patch_list("---\ntitle: T\ntags:\n  - a\n---\nbody", "tags", &[]);
        assert_eq!(out, "---\ntitle: T\n---\nbody");
    }

    #[test]
    fn patch_on_a_document_with_no_block_and_no_values_is_a_noop() {
        assert_eq!(patch_list("plain\n", "tags", &[]), "plain\n");
    }

    #[test]
    fn patch_leaves_other_keys_byte_identical() {
        let text = "---\nz-last: kept\ntags: old\na-first: 'also kept'\n---\n\nbody text\n";
        let out = patch_list(text, "tags", &["x".to_string()]);
        assert!(out.contains("z-last: kept\n"));
        assert!(out.contains("a-first: 'also kept'\n"));
        assert!(out.ends_with("---\n\nbody text\n"));
    }

    #[test]
    fn patch_round_trips_through_parse() {
        let out = patch_list("---\ntitle: T\n---\nbody", "aliases", &[
            "one".to_string(),
            "two".to_string(),
        ]);
        let fm = parse(&out);
        assert_eq!(fm.get("aliases"), ["one".to_string(), "two".to_string()]);
        assert_eq!(fm.first("title"), Some("T"));
        assert_eq!(content_of(&out, &fm), "body");
    }

    #[test]
    fn values_containing_commas_survive_a_round_trip() {
        // Why lists always serialize in block form: no escaping needed.
        let out = patch_list("---\nt: x\n---\n", "tags", &["a, b".to_string(), "c".to_string()]);
        assert_eq!(parse(&out).get("tags"), ["a, b".to_string(), "c".to_string()]);
    }

    // -----------------------------------------------------------------------
    // Shared corpus. `frontend/src/notes/parity.test.ts` runs the same file
    // against the TypeScript mirror, so a change to one grammar that isn't made
    // to the other fails here.
    // -----------------------------------------------------------------------

    use sonic_rs::{JsonContainerTrait, JsonValueTrait};

    const PARITY: &str = include_str!("../../../fixtures/notes/parity.json");

    fn strings(value: &sonic_rs::Value) -> Vec<String> {
        value
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn shared_corpus_frontmatter() {
        let root: sonic_rs::Value = sonic_rs::from_str(PARITY).expect("fixture is valid json");
        let cases = root["frontmatter"].as_array().expect("frontmatter array");
        assert!(!cases.is_empty(), "fixture must not be empty");

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let text = case["text"].as_str().expect("text");
            let fm = parse(text);

            let expected: Vec<(String, Vec<String>)> = case["entries"]
                .as_array()
                .expect("entries")
                .iter()
                .map(|pair| {
                    let entry = pair.as_array().expect("entry pair");
                    (
                        entry[0].as_str().unwrap_or_default().to_string(),
                        strings(&entry[1]),
                    )
                })
                .collect();

            let actual: Vec<(String, Vec<String>)> = fm
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_vec()))
                .collect();

            assert_eq!(actual, expected, "entries mismatch in case {name:?}");
            assert_eq!(
                content_of(text, &fm),
                case["content"].as_str().expect("content"),
                "content mismatch in case {name:?}"
            );
        }
    }

    #[test]
    fn shared_corpus_patch() {
        let root: sonic_rs::Value = sonic_rs::from_str(PARITY).expect("fixture is valid json");
        for case in root["patch"].as_array().expect("patch array") {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let out = patch_list(
                case["text"].as_str().expect("text"),
                case["key"].as_str().expect("key"),
                &strings(&case["values"]),
            );
            assert_eq!(out, case["out"].as_str().expect("out"), "case {name:?}");
        }
    }

    #[test]
    fn shared_corpus_slugs() {
        let root: sonic_rs::Value = sonic_rs::from_str(PARITY).expect("fixture is valid json");
        for case in root["slugs"].as_array().expect("slugs array") {
            let input = case["in"].as_str().expect("in");
            assert_eq!(
                crate::slug::slugify(input),
                case["out"].as_str().expect("out"),
                "slug mismatch for {input:?}"
            );
        }
    }
}
