use hyper::header::{CACHE_CONTROL, HeaderValue};
use hyper::{Request, StatusCode};
use rand::RngExt;
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
use sonic_rs::{Deserialize, Serialize};
use std::sync::LazyLock;
use thiserror::Error;

use crate::response::{self, ApiError, Body, ResponseBuilder};

/// Every draw hits the OS CSPRNG directly (no userspace PRNG buffering/reseeding),
/// so a template with many tokens can take a moment — that's expected.
type SecureRng = UnwrapErr<SysRng>;

/// Alphabet for `{p…}` tokens: letters (both cases), digits, and `!?£&*`.
static PASSWORD_ALPHABET: LazyLock<Vec<char>> = LazyLock::new(|| {
    ('a'..='z')
        .chain('A'..='Z')
        .chain('0'..='9')
        .chain("!?£&*".chars())
        .collect()
});

/// Alphabet for `{b…}` tokens: the URL-safe base64 characters.
static BASE64_ALPHABET: LazyLock<Vec<char>> = LazyLock::new(|| {
    ('A'..='Z')
        .chain('a'..='z')
        .chain('0'..='9')
        .chain(['-', '_'])
        .collect()
});

/// Alphabet for `{?}` tokens: every ASCII keyboard punctuation character.
static PUNCTUATION: LazyLock<Vec<char>> = LazyLock::new(|| {
    (b'!'..=b'~')
        .map(char::from)
        .filter(char::is_ascii_punctuation)
        .collect()
});

/// Separators for the `{s}` (random each time) and `{S}` (chosen once per
/// generated password and reused for every `{S}`) tokens.
static SEPARATORS: &[char] = &['-', '+', '/', '\\', '=', '_', ':'];

/// Codepoint range for `{e}` tokens: the Unicode "Emoticons" block (😀..🙏).
/// Every value in it is a valid scalar value, so `char::from_u32` never fails.
const EMOJI_RANGE: std::ops::RangeInclusive<u32> = 0x1F600..=0x1F64F;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PasswordTemplateError {
    #[error("unterminated '{{' in template")]
    UnterminatedToken,
    #[error("unknown token '{{{0}}}'")]
    UnknownToken(String),
    #[error("invalid number in token '{{{0}}}'")]
    InvalidNumber(String),
    #[error("invalid range in token '{{{0}}}': start must not exceed end")]
    InvalidRange(String),
}

/// A named password template, offered to callers via `GET /password/types` and
/// selectable by `label` through the `type` field of `POST /password`.
#[derive(Serialize)]
pub struct Preset {
    pub label: &'static str,
    pub template: &'static str,
    pub hint: &'static str,
}

/// The built-in presets. The frontend renders these as one-click chips and
/// resolves `type` selections against them, so this list is the single source
/// of truth for both ends.
pub static PRESETS: &[Preset] = &[
    Preset {
        label: "Memorable",
        template: "{W}-{W}-{W}{n4}{?}",
        hint: "Three words + digits",
    },
    Preset {
        label: "Passphrase",
        template: "{w} {w} {w} {w}",
        hint: "Four words, spaced",
    },
    Preset {
        label: "Strong",
        template: "{p24}",
        hint: "24 mixed characters",
    },
    Preset {
        label: "PIN",
        template: "{n6}",
        hint: "Six digits",
    },
    Preset {
        label: "Base64 key",
        template: "{b32}",
        hint: "32 URL-safe chars",
    },
    Preset {
        label: "UUID",
        template: "{u}",
        hint: "Random v4 UUID",
    },
];

/// Resolves a preset `label` (case-insensitive) to its template.
pub fn preset_template(label: &str) -> Option<&'static str> {
    PRESETS
        .iter()
        .find(|preset| preset.label.eq_ignore_ascii_case(label))
        .map(|preset| preset.template)
}

/// A `POST /password` body: an explicit `template`, or a `type` naming one of the
/// built-in presets. `template` wins if both are present.
#[derive(Deserialize)]
struct PasswordRequest {
    template: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// The `POST /password` reply: the template echoed back, the generated password,
/// and two entropy figures in bits — `entropy` for this exact password and
/// `min_entropy` for the weakest the template could produce (see [`Generated`]).
#[derive(Serialize)]
struct PasswordReply {
    template: String,
    password: String,
    entropy: f64,
    min_entropy: f64,
}

/// Handles `GET /password/types`, listing the built-in presets as JSON.
pub fn types_response() -> hyper::Response<Body> {
    ResponseBuilder::new(StatusCode::OK).json(&PRESETS).into()
}

/// Handles `POST /password` with a JSON body `{"template": "..."}` or
/// `{"type": "..."}`, replying with `{template, password, entropy}` as JSON.
/// Returns a bad-request error if the body isn't valid JSON or the template is
/// invalid.
pub async fn respond(req: Request<hyper::body::Incoming>) -> hyper::Response<Body> {
    let request: PasswordRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"template": "{w}-{w}-{n4}"} or {"type": "Memorable"}"#,
    )
    .await
    {
        Ok(request) => request,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let template = match resolve_template(request.template, request.kind) {
        Ok(template) => template,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let bad_request = |err: PasswordTemplateError| {
        ResponseBuilder::from(ApiError::BadRequest(err.to_string())).into()
    };
    // Generate and score in one pass: `entropy` is the actual generated
    // password's entropy, `min_entropy` the floor the template guarantees.
    let generated = match generate_scored(&template) {
        Ok(generated) => generated,
        Err(err) => return bad_request(err),
    };
    // A generated password is a secret drawn fresh per request; never let a
    // cache (browser, proxy, or a QUERY cache keyed on the request body) retain
    // or replay it.
    ResponseBuilder::new(StatusCode::OK)
        .header(CACHE_CONTROL, HeaderValue::from_static("no-store"))
        .json(&PasswordReply {
            template,
            password: generated.password,
            entropy: generated.entropy,
            min_entropy: generated.min_entropy,
        })
        .into()
}

/// Resolves a request's template: an explicit `template`, else the preset named
/// by `type` (`template` wins when both are given). Errors if neither is present
/// or the named type is unknown.
fn resolve_template(template: Option<String>, kind: Option<String>) -> Result<String, ApiError> {
    match template {
        Some(template) => Ok(template),
        None => match kind {
            Some(label) => preset_template(&label)
                .map(str::to_string)
                .ok_or_else(|| ApiError::BadRequest(format!("unknown type {label:?}"))),
            None => Err(ApiError::BadRequest(
                r#"provide a "template" or a "type""#.into(),
            )),
        },
    }
}

/// A generated password with its entropy in bits.
///
/// `entropy` is the *realised* entropy: the self-information of this exact
/// password, `sum of log2(choices)` over every random decision generation
/// actually made — for a range token `{XA-B}`, the count that was drawn, not an
/// average over the lengths the template could have produced. `min_entropy` is
/// the weakest the template could ever produce (each range at its shortest
/// length), a guaranteed floor. The two are equal unless the template has a
/// range token; always `min_entropy <= entropy`.
pub struct Generated {
    pub password: String,
    pub entropy: f64,
    pub min_entropy: f64,
}

/// Expands a password template, e.g. `{w}-{w}-{w}{n}` or `{b12}@hotmail.com`,
/// returning the [`Generated`] password and its entropy.
///
/// A token is `{X}` for one item, `{XN}` for N, or `{XA-B}` for a random count in
/// `A..=B`. The range form may append a separator woven between items, as in
/// `{w2-4- }`. Tokens (`{Y}`, `{C}`, `{s}`, `{S}`, `{u}` take no count):
/// - `{w}` word          `{W}` Capitalised word   `{Y}` SCREAMING word
/// - `{l}` lowercase letter                        `{L}` (or `{C}`) uppercase letter
/// - `{n}` digit   `{b}` base64 char   `{p}` char of `[a-zA-Z0-9!?£&*]`
/// - `{?}` ASCII punctuation   `{e}` emoji   `{u}` UUID v4
/// - separators from `-+/\=_:`: `{s}` random each time, `{S}` drawn once and shared
///
/// All randomness is drawn fresh from the OS CSPRNG (`SysRng`) per token, so
/// output is never reproducible/seeded.
pub fn generate_scored(template: &str) -> Result<Generated, PasswordTemplateError> {
    let mut rng = UnwrapErr(SysRng);
    let mut out = String::with_capacity(template.len());
    let mut entropy = 0.0;
    let mut min_entropy = 0.0;
    // The shared separator for `{S}` tokens is chosen at most once per call and
    // reused, so every `{S}` in this password expands to the same character (and
    // is counted once). `{s}` draws an independent separator each time.
    let mut separator: Option<char> = None;
    walk(template, |segment| {
        match segment {
            Segment::Literal(ch) => out.push(ch),
            Segment::Token(token) => {
                let (text, bits) = expand_token(token, &mut rng, &mut separator)?;
                out.push_str(&text);
                entropy += bits.realised;
                min_entropy += bits.min;
            }
        }
        Ok(())
    })?;
    Ok(Generated {
        password: out,
        entropy,
        min_entropy,
    })
}

/// A single element of a parsed template, yielded by [`walk`].
enum Segment<'a> {
    /// A literal character, copied through verbatim.
    Literal(char),
    /// The inner text of a `{...}` token, without the braces.
    Token(&'a str),
}

/// Walks `template` left to right, handing each literal character and each
/// `{...}` token's inner text to `visit` in order. Errors on an unterminated
/// `{`.
fn walk<F>(template: &str, mut visit: F) -> Result<(), PasswordTemplateError>
where
    F: FnMut(Segment) -> Result<(), PasswordTemplateError>,
{
    let mut chars = template.char_indices();
    while let Some((start, ch)) = chars.next() {
        if ch != '{' {
            visit(Segment::Literal(ch))?;
            continue;
        }

        let mut end = None;
        for (idx, c) in chars.by_ref() {
            if c == '}' {
                end = Some(idx);
                break;
            }
        }
        let end = end.ok_or(PasswordTemplateError::UnterminatedToken)?;
        visit(Segment::Token(&template[start + 1..end]))?;
    }
    Ok(())
}

fn word_bits() -> f64 {
    (am_wordlist::LEN as f64).log2()
}
fn letter_bits() -> f64 {
    26f64.log2()
}
fn digit_bits() -> f64 {
    10f64.log2()
}
fn base64_bits() -> f64 {
    (BASE64_ALPHABET.len() as f64).log2()
}
fn password_bits() -> f64 {
    (PASSWORD_ALPHABET.len() as f64).log2()
}
fn punctuation_bits() -> f64 {
    (PUNCTUATION.len() as f64).log2()
}
fn emoji_bits() -> f64 {
    ((EMOJI_RANGE.end() - EMOJI_RANGE.start() + 1) as f64).log2()
}
fn separator_bits() -> f64 {
    (SEPARATORS.len() as f64).log2()
}
/// A v4 UUID fixes 4 version + 2 variant bits, leaving 122 bits of randomness.
const UUID_V4_BITS: f64 = 122.0;

/// Entropy, in bits, contributed by one token: `realised` for the choices this
/// generation actually made, `min` for the fewest it could have made (a range's
/// shortest length). The two are equal except for range tokens.
#[derive(Clone, Copy)]
struct Bits {
    realised: f64,
    min: f64,
}

impl Bits {
    /// A token whose entropy doesn't depend on a drawn count: `realised == min`.
    fn flat(bits: f64) -> Self {
        Bits {
            realised: bits,
            min: bits,
        }
    }
}

/// Expands one token into its text and the entropy, in bits, of the random
/// choices that produced it. Mirrors nothing else: this is the single place that
/// knows each token's alphabet, so generation and scoring can never drift.
fn expand_token(
    token: &str,
    rng: &mut SecureRng,
    separator: &mut Option<char>,
) -> Result<(String, Bits), PasswordTemplateError> {
    match token {
        // Separators: `{s}` is drawn fresh each time; `{S}` is drawn once and
        // reused for every `{S}` in the password, so only its first draw is real.
        "s" => Ok((pick(SEPARATORS, rng).to_string(), Bits::flat(separator_bits()))),
        "S" => {
            let fresh = separator.is_none();
            let ch = *separator.get_or_insert_with(|| pick(SEPARATORS, rng));
            Ok((ch.to_string(), Bits::flat(if fresh { separator_bits() } else { 0.0 })))
        }
        // Countless tokens, and the bare (single-item) form of counted ones.
        "w" => Ok((random_word(rng).to_string(), Bits::flat(word_bits()))),
        "W" => Ok((capitalise(random_word(rng)), Bits::flat(word_bits()))),
        "Y" => Ok((random_word(rng).to_uppercase(), Bits::flat(word_bits()))),
        "l" => Ok((random_letter(b'a', rng).to_string(), Bits::flat(letter_bits()))),
        "L" | "C" => Ok((random_letter(b'A', rng).to_string(), Bits::flat(letter_bits()))),
        "n" => Ok((random_digit(rng).to_string(), Bits::flat(digit_bits()))),
        "b" => Ok((pick(&BASE64_ALPHABET, rng).to_string(), Bits::flat(base64_bits()))),
        "p" => Ok((pick(&PASSWORD_ALPHABET, rng).to_string(), Bits::flat(password_bits()))),
        "?" => Ok((pick(&PUNCTUATION, rng).to_string(), Bits::flat(punctuation_bits()))),
        "e" => Ok((random_emoji(rng).to_string(), Bits::flat(emoji_bits()))),
        "u" => Ok((uuid::Uuid::new_v4().to_string(), Bits::flat(UUID_V4_BITS))),
        // Counted tokens: `{XN}` / `{XA-B}` / `{XA-B-sep}`.
        _ if token.starts_with('w') => count(token, rng, word_bits(), |r| random_word(r).to_string()),
        _ if token.starts_with('W') => count(token, rng, word_bits(), |r| capitalise(random_word(r))),
        _ if token.starts_with('l') => {
            count(token, rng, letter_bits(), |r| random_letter(b'a', r).to_string())
        }
        _ if token.starts_with('L') => {
            count(token, rng, letter_bits(), |r| random_letter(b'A', r).to_string())
        }
        _ if token.starts_with('n') => count(token, rng, digit_bits(), |r| random_digit(r).to_string()),
        _ if token.starts_with('b') => {
            count(token, rng, base64_bits(), |r| pick(&BASE64_ALPHABET, r).to_string())
        }
        _ if token.starts_with('p') => {
            count(token, rng, password_bits(), |r| pick(&PASSWORD_ALPHABET, r).to_string())
        }
        _ if token.starts_with('?') => {
            count(token, rng, punctuation_bits(), |r| pick(&PUNCTUATION, r).to_string())
        }
        _ if token.starts_with('e') => count(token, rng, emoji_bits(), |r| random_emoji(r).to_string()),
        _ => Err(PasswordTemplateError::UnknownToken(token.to_string())),
    }
}

/// Parses the count spec following `token`'s leading letter, emits that many
/// `item`s joined by the spec's separator, and returns the text with the entropy
/// of the drawn count and items (`item_bits` per item).
fn count(
    token: &str,
    rng: &mut SecureRng,
    item_bits: f64,
    item: impl FnMut(&mut SecureRng) -> String,
) -> Result<(String, Bits), PasswordTemplateError> {
    let spec = CountSpec::parse(token, &token[1..], rng)?;
    let bits = spec.bits(item_bits);
    Ok((spec.build(item, rng), bits))
}

/// A parsed count spec: how many items to emit, the fewest the spec permits, how
/// many counts it permits (`choices`), and the phrase to join items with.
struct CountSpec {
    count: usize,
    lo: usize,
    choices: usize,
    join: String,
}

impl CountSpec {
    /// Parses `spec` (the part after the token letter) as a fixed `N`, a range
    /// `A-B`, or a range with a join phrase `A-B-sep`. The separator may itself
    /// contain `-`, so only the first two `-` are structural.
    fn parse(token: &str, spec: &str, rng: &mut SecureRng) -> Result<Self, PasswordTemplateError> {
        let invalid_number = || PasswordTemplateError::InvalidNumber(token.to_string());
        let mut parts = spec.splitn(3, '-');
        let first = parts.next().unwrap_or(spec);

        match parts.next() {
            None => {
                let n = first.parse().map_err(|_| invalid_number())?;
                Ok(Self {
                    count: n,
                    lo: n,
                    choices: 1,
                    join: String::new(),
                })
            }
            Some(hi) => {
                let lo: usize = first.parse().map_err(|_| invalid_number())?;
                let hi: usize = hi.parse().map_err(|_| invalid_number())?;
                if lo > hi {
                    return Err(PasswordTemplateError::InvalidRange(token.to_string()));
                }
                Ok(Self {
                    count: rng.random_range(lo..=hi),
                    lo,
                    choices: hi - lo + 1,
                    join: parts.next().unwrap_or("").to_string(),
                })
            }
        }
    }

    /// Entropy contributed by this spec's count and items. The count is drawn
    /// uniformly from `choices` options (`log2(choices)`, zero for a fixed count);
    /// `realised` adds the drawn count's item bits, `min` the shortest count's.
    fn bits(&self, item_bits: f64) -> Bits {
        let count_bits = (self.choices as f64).log2();
        Bits {
            realised: count_bits + self.count as f64 * item_bits,
            min: count_bits + self.lo as f64 * item_bits,
        }
    }

    fn build(&self, mut item: impl FnMut(&mut SecureRng) -> String, rng: &mut SecureRng) -> String {
        let mut out = String::new();
        for i in 0..self.count {
            if i > 0 {
                out.push_str(&self.join);
            }
            out.push_str(&item(rng));
        }
        out
    }
}

/// Upper-cases the first character of `word`, leaving the rest unchanged.
fn capitalise(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn random_word(rng: &mut SecureRng) -> &'static str {
    let idx = rng.random_range(0..am_wordlist::LEN);
    am_wordlist::get(idx).unwrap_or_default()
}

fn random_letter(base: u8, rng: &mut SecureRng) -> char {
    char::from(base + rng.random_range(0..26u8))
}

fn random_digit(rng: &mut SecureRng) -> char {
    char::from(b'0' + rng.random_range(0..10u8))
}

/// A random codepoint from the Emoticons block. Not every codepoint there is an
/// assigned emoji, but all are valid `char`s, matching "a number in the range".
fn random_emoji(rng: &mut SecureRng) -> char {
    char::from_u32(rng.random_range(EMOJI_RANGE)).unwrap_or('\u{1F600}')
}

fn pick(alphabet: &[char], rng: &mut SecureRng) -> char {
    alphabet[rng.random_range(0..alphabet.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_word(w: &str) -> bool {
        (0..am_wordlist::LEN).any(|i| am_wordlist::get(i) == Some(w))
    }

    /// Just the password text — most tests only check the generated string.
    fn generate(template: &str) -> Result<String, PasswordTemplateError> {
        generate_scored(template).map(|generated| generated.password)
    }

    /// The realised entropy of a generated password. For templates without a
    /// range token this is deterministic, so tests can assert an exact value.
    fn realised(template: &str) -> f64 {
        generate_scored(template).unwrap().entropy
    }

    #[test]
    fn word_number_phrase() {
        let out = generate("{w}-{w}-{w}{n}").unwrap();
        let parts: Vec<&str> = out.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert!(is_word(parts[0]));
        assert!(is_word(parts[1]));
        let (word, digit) = parts[2].split_at(parts[2].len() - 1);
        assert!(is_word(word));
        assert!(digit.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn capital_word() {
        for _ in 0..50 {
            let out = generate("{W}").unwrap();
            let mut chars = out.chars();
            let first = chars.next().unwrap();
            assert!(
                first.is_ascii_uppercase(),
                "expected leading capital in {out}"
            );
            assert!(is_word(&out.to_lowercase()));
        }
    }

    #[test]
    fn capital_letter() {
        for _ in 0..50 {
            let out = generate("{C}").unwrap();
            assert_eq!(out.chars().count(), 1);
            assert!(out.chars().all(|c| c.is_ascii_uppercase()));
        }
    }

    #[test]
    fn lowercase_letters() {
        let single = generate("{l}").unwrap();
        assert_eq!(single.chars().count(), 1);
        for _ in 0..50 {
            let out = generate("{l5}").unwrap();
            assert_eq!(out.chars().count(), 5);
            assert!(out.chars().all(|c| c.is_ascii_lowercase()));
        }
    }

    #[test]
    fn uppercase_letters() {
        let single = generate("{L}").unwrap();
        assert_eq!(single.chars().count(), 1);
        for _ in 0..50 {
            let out = generate("{L3-6}").unwrap();
            let count = out.chars().count();
            assert!((3..=6).contains(&count), "unexpected length {count}");
            assert!(out.chars().all(|c| c.is_ascii_uppercase()));
        }
    }

    #[test]
    fn word_count() {
        let out = generate("{w3}").unwrap();
        // Fixed count of 3 words, concatenated with no separator.
        assert!(!out.is_empty());
        assert!(out.chars().all(|c| c.is_ascii_lowercase()));
    }

    #[test]
    fn capital_word_count() {
        let out = generate("{W3-3}").unwrap();
        // Three capitalised words concatenated, e.g. `MobileCatDog`.
        let capitals = out.chars().filter(|c| c.is_ascii_uppercase()).count();
        assert_eq!(capitals, 3);
    }

    #[test]
    fn punctuation_token() {
        let single = generate("{?}").unwrap();
        assert_eq!(single.chars().count(), 1);
        for _ in 0..50 {
            let out = generate("{?6}").unwrap();
            assert_eq!(out.chars().count(), 6);
            assert!(out.chars().all(|c| c.is_ascii_punctuation()));
        }
    }

    #[test]
    fn emoji_token() {
        let single = generate("{e}").unwrap();
        assert_eq!(single.chars().count(), 1);
        for _ in 0..50 {
            let out = generate("{e4}").unwrap();
            assert_eq!(out.chars().count(), 4);
            assert!(out.chars().all(|c| EMOJI_RANGE.contains(&(c as u32))));
        }
    }

    #[test]
    fn separator_tokens_from_set() {
        for token in ["{s}", "{S}"] {
            for _ in 0..50 {
                let out = generate(token).unwrap();
                assert_eq!(out.chars().count(), 1);
                assert!(SEPARATORS.contains(&out.chars().next().unwrap()));
            }
        }
    }

    #[test]
    fn shared_separator_is_consistent_within_password() {
        for _ in 0..50 {
            // Digits can't collide with separators, so positions 1 and 3 are the
            // two `{S}` expansions and must be the identical character.
            let out = generate("{n1}{S}{n1}{S}{n1}").unwrap();
            let chars: Vec<char> = out.chars().collect();
            assert_eq!(chars.len(), 5);
            assert!(SEPARATORS.contains(&chars[1]));
            assert_eq!(chars[1], chars[3], "shared separators differ in {out}");
        }
    }

    #[test]
    fn random_separator_varies_across_positions() {
        // `{s}` is drawn independently, so over enough runs of a two-`{s}`
        // template the two positions must sometimes differ. (With a 7-char set
        // the odds of 200 identical pairs by chance are ~7^-200.)
        let differed = (0..200).any(|_| {
            let out = generate("{n1}{s}{n1}{s}{n1}").unwrap();
            let chars: Vec<char> = out.chars().collect();
            chars[1] != chars[3]
        });
        assert!(differed, "{{s}} never varied across 200 runs");
    }

    #[test]
    fn separators_reject_count() {
        // Both separator tokens are countless; the counted forms are unknown.
        assert_eq!(
            generate("{s2}"),
            Err(PasswordTemplateError::UnknownToken("s2".to_string()))
        );
        assert_eq!(
            generate("{S2}"),
            Err(PasswordTemplateError::UnknownToken("S2".to_string()))
        );
    }

    #[test]
    fn screaming_word_token() {
        for _ in 0..50 {
            let out = generate("{Y}").unwrap();
            assert!(out.chars().all(|c| c.is_ascii_uppercase()));
            assert!(is_word(&out.to_lowercase()));
        }
    }

    #[test]
    fn entropy_of_separators() {
        let sep_bits = (SEPARATORS.len() as f64).log2();
        // A single independent `{s}` and a single shared `{S}` are each one draw.
        assert!((realised("{s}") - sep_bits).abs() < 1e-9);
        assert!((realised("{S}") - sep_bits).abs() < 1e-9);
        // Independent `{s}` accumulate; correlated `{S}` are counted once.
        assert!((realised("{s}{s}") - 2.0 * sep_bits).abs() < 1e-9);
        assert!((realised("{S}{S}{S}") - sep_bits).abs() < 1e-9);
        // A realistic mix: three words joined by a single shared separator.
        let expected = 3.0 * (am_wordlist::LEN as f64).log2() + sep_bits;
        assert!((realised("{W}{S}{W}{S}{W}") - expected).abs() < 1e-9);
    }

    #[test]
    fn range_with_join_phrase() {
        for _ in 0..50 {
            let out = generate("{w3-3-::}").unwrap();
            let parts: Vec<&str> = out.split("::").collect();
            assert_eq!(parts.len(), 3);
            assert!(parts.iter().all(|p| is_word(p)));
        }
    }

    #[test]
    fn join_phrase_may_contain_dashes() {
        // Only the first two `-` are structural, so the separator here is `-`.
        let out = generate("{n4-4--}").unwrap();
        let parts: Vec<&str> = out.split('-').collect();
        assert_eq!(parts.len(), 4);
        assert!(
            parts
                .iter()
                .all(|p| p.len() == 1 && p.chars().all(|c| c.is_ascii_digit()))
        );
    }

    #[test]
    fn join_phrase_ignored_without_range() {
        // Fixed count has no separator slot, so `{n3}` is just three digits.
        let out = generate("{n3}").unwrap();
        assert_eq!(out.chars().count(), 3);
    }

    #[test]
    fn digits_fixed_length() {
        for _ in 0..50 {
            let out = generate("{n6}").unwrap();
            assert_eq!(out.chars().count(), 6);
            assert!(out.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn digits_range_length() {
        for _ in 0..50 {
            let out = generate("{n2-5}").unwrap();
            let count = out.chars().count();
            assert!((2..=5).contains(&count), "unexpected length {count}");
            assert!(out.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn base64_fixed_length_with_suffix() {
        let out = generate("{b12}@hotmail.com").unwrap();
        assert_eq!(out, format!("{}@hotmail.com", &out[..12]));
        assert_eq!(out[..12].chars().count(), 12);
    }

    #[test]
    fn base64_range_length() {
        for _ in 0..50 {
            let out = generate("{b0-24}").unwrap();
            assert!(out.chars().count() <= 24);
        }
    }

    #[test]
    fn uuid_token() {
        let out = generate("{u}").unwrap();
        assert!(uuid::Uuid::parse_str(&out).is_ok());
    }

    #[test]
    fn resolve_prefers_explicit_template() {
        // template wins even when a type is also supplied
        let out = resolve_template(Some("{n4}".into()), Some("PIN".into())).unwrap();
        assert_eq!(out, "{n4}");
    }

    #[test]
    fn resolve_uses_preset_by_type_case_insensitively() {
        assert_eq!(resolve_template(None, Some("pin".into())).unwrap(), "{n6}");
        assert_eq!(
            resolve_template(None, Some("Memorable".into())).unwrap(),
            "{W}-{W}-{W}{n4}{?}"
        );
    }

    #[test]
    fn resolve_rejects_unknown_type() {
        assert!(matches!(
            resolve_template(None, Some("nope".into())),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn resolve_requires_template_or_type() {
        assert!(matches!(
            resolve_template(None, None),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn presets_are_valid_templates() {
        for preset in PRESETS {
            assert!(
                generate(preset.template).is_ok(),
                "bad preset {}",
                preset.label
            );
            assert!(
                generate_scored(preset.template).unwrap().entropy > 0.0,
                "bad preset {}",
                preset.label
            );
            assert_eq!(preset_template(preset.label), Some(preset.template));
        }
        // Lookup is case-insensitive and rejects unknown labels.
        assert_eq!(preset_template("memorable"), Some("{W}-{W}-{W}{n4}{?}"));
        assert_eq!(preset_template("nope"), None);
    }

    #[test]
    fn entropy_sums_token_bits() {
        // Literals add nothing; {n6} is six digits, {?} one punctuation char.
        let expected = 6.0 * 10f64.log2() + (PUNCTUATION.len() as f64).log2();
        assert!((realised("pw-{n6}{?}") - expected).abs() < 1e-9);
    }

    #[test]
    fn entropy_of_uuid_is_122_bits() {
        assert_eq!(realised("{u}"), 122.0);
    }

    #[test]
    fn realised_entropy_uses_the_drawn_count() {
        // {n2-6}: log2(5) for the count, plus the *actual* number of digits drawn
        // (not the mean). The floor uses the shortest length, two digits.
        let count_bits = 5f64.log2();
        let digit_bits = 10f64.log2();
        for _ in 0..100 {
            let g = generate_scored("{n2-6}").unwrap();
            let k = g.password.chars().count();
            assert!((2..=6).contains(&k), "unexpected length {k}");
            assert!((g.entropy - (count_bits + k as f64 * digit_bits)).abs() < 1e-9);
            assert!((g.min_entropy - (count_bits + 2.0 * digit_bits)).abs() < 1e-9);
            assert!(g.min_entropy <= g.entropy + 1e-9);
        }
    }

    #[test]
    fn realised_entropy_varies_with_drawn_length() {
        // A range template's realised entropy tracks the drawn count, so over many
        // draws it must take more than one value — proving it isn't a fixed mean.
        let seen: std::collections::HashSet<u64> = (0..300)
            .map(|_| generate_scored("{w3-6}").unwrap().entropy.to_bits())
            .collect();
        assert!(seen.len() > 1, "range entropy never varied across 300 draws");
    }

    #[test]
    fn min_entropy_equals_entropy_without_ranges() {
        // With no range token there's nothing to vary, so the floor is exact.
        let g = generate_scored("{W}-{W}-{W}{n4}{?}").unwrap();
        assert_eq!(g.min_entropy, g.entropy);
    }

    #[test]
    fn scoring_rejects_what_generate_rejects() {
        assert_eq!(
            generate_scored("{x}").map(|_| ()),
            Err(PasswordTemplateError::UnknownToken("x".into()))
        );
        assert_eq!(
            generate_scored("{w").map(|_| ()),
            Err(PasswordTemplateError::UnterminatedToken)
        );
        assert_eq!(
            generate_scored("{b10-2}").map(|_| ()),
            Err(PasswordTemplateError::InvalidRange("b10-2".into()))
        );
    }

    #[test]
    fn unterminated_token_errors() {
        assert_eq!(
            generate("{w"),
            Err(PasswordTemplateError::UnterminatedToken)
        );
    }

    #[test]
    fn unknown_token_errors() {
        assert_eq!(
            generate("{x}"),
            Err(PasswordTemplateError::UnknownToken("x".to_string()))
        );
    }

    #[test]
    fn invalid_range_errors() {
        assert_eq!(
            generate("{b10-2}"),
            Err(PasswordTemplateError::InvalidRange("b10-2".to_string()))
        );
    }

    #[test]
    fn zero_length_base64_is_empty() {
        assert_eq!(generate("{b0}").unwrap(), "");
    }

    #[test]
    fn bare_single_item_tokens() {
        // The bare `{p}`/`{b}` forms emit exactly one char from their alphabet;
        // they must not fall through to the counted path (which would try to
        // parse an empty count and fail with InvalidNumber).
        let p = generate("{p}").unwrap();
        assert_eq!(p.chars().count(), 1);
        assert!(PASSWORD_ALPHABET.contains(&p.chars().next().unwrap()));

        let b = generate("{b}").unwrap();
        assert_eq!(b.chars().count(), 1);
        assert!(BASE64_ALPHABET.contains(&b.chars().next().unwrap()));
    }

    #[test]
    fn password_fixed_length_charset() {
        for _ in 0..50 {
            let out = generate("{p16}").unwrap();
            assert_eq!(out.chars().count(), 16);
            assert!(out.chars().all(|c| PASSWORD_ALPHABET.contains(&c)));
        }
    }

    #[test]
    fn password_range_length() {
        for _ in 0..50 {
            let out = generate("{p4-8}").unwrap();
            let count = out.chars().count();
            assert!((4..=8).contains(&count), "unexpected length {count}");
            assert!(out.chars().all(|c| PASSWORD_ALPHABET.contains(&c)));
        }
    }

    #[test]
    fn password_alphabet_membership() {
        // Covers letters (both cases), digits, and the symbol set.
        for c in ['a', 'Z', '0', '9', '!', '?', '£', '&', '*'] {
            assert!(PASSWORD_ALPHABET.contains(&c), "missing {c}");
        }
        assert_eq!(PASSWORD_ALPHABET.len(), 26 + 26 + 10 + 5);
    }
}
