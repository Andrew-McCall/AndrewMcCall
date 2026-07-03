use rand::RngExt;
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
use std::sync::LazyLock;
use thiserror::Error;

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

/// Expands a password template, e.g. `{w}-{w}-{w}{n}` or `{b12}@hotmail.com`.
///
/// A token is `{X}` for one item, `{XN}` for N, or `{XA-B}` for a random count in
/// `A..=B`. The range form may append a separator woven between items, as in
/// `{w2-4- }`. Tokens (`{S}`, `{C}`, `{u}` take no count):
/// - `{w}` word          `{W}` Capitalised word   `{S}` SCREAMING word
/// - `{l}` lowercase letter                        `{L}` (or `{C}`) uppercase letter
/// - `{n}` digit   `{b}` base64 char   `{p}` char of `[a-zA-Z0-9!?£&*]`
/// - `{?}` ASCII punctuation   `{e}` emoji   `{u}` UUID v4
///
/// All randomness is drawn fresh from the OS CSPRNG (`SysRng`) per token, so
/// output is never reproducible/seeded.
pub fn generate(template: &str) -> Result<String, PasswordTemplateError> {
    let mut out = String::with_capacity(template.len());
    let mut rng = UnwrapErr(SysRng);
    let mut chars = template.char_indices().peekable();

    while let Some((start, ch)) = chars.next() {
        if ch != '{' {
            out.push(ch);
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
        let token = &template[start + 1..end];

        out.push_str(&expand_token(token, &mut rng)?);
    }

    Ok(out)
}

fn expand_token(token: &str, rng: &mut SecureRng) -> Result<String, PasswordTemplateError> {
    match token {
        // Countless tokens, and the bare (single-item) form of counted ones.
        "w" => Ok(random_word(rng).to_string()),
        "W" => Ok(capitalise(random_word(rng))),
        "S" => Ok(random_word(rng).to_uppercase()),
        "l" => Ok(random_letter(b'a', rng).to_string()),
        "L" | "C" => Ok(random_letter(b'A', rng).to_string()),
        "n" => Ok(random_digit(rng).to_string()),
        "?" => Ok(pick(&PUNCTUATION, rng).to_string()),
        "e" => Ok(random_emoji(rng).to_string()),
        "u" => Ok(uuid::Uuid::new_v4().to_string()),
        // Counted tokens: `{XN}` / `{XA-B}` / `{XA-B-sep}`.
        _ if token.starts_with('w') => count(token, rng, |r| random_word(r).to_string()),
        _ if token.starts_with('W') => count(token, rng, |r| capitalise(random_word(r))),
        _ if token.starts_with('l') => count(token, rng, |r| random_letter(b'a', r).to_string()),
        _ if token.starts_with('L') => count(token, rng, |r| random_letter(b'A', r).to_string()),
        _ if token.starts_with('n') => count(token, rng, |r| random_digit(r).to_string()),
        _ if token.starts_with('b') => count(token, rng, |r| pick(&BASE64_ALPHABET, r).to_string()),
        _ if token.starts_with('p') => {
            count(token, rng, |r| pick(&PASSWORD_ALPHABET, r).to_string())
        }
        _ if token.starts_with('?') => count(token, rng, |r| pick(&PUNCTUATION, r).to_string()),
        _ if token.starts_with('e') => count(token, rng, |r| random_emoji(r).to_string()),
        _ => Err(PasswordTemplateError::UnknownToken(token.to_string())),
    }
}

/// Parses the count spec following `token`'s leading letter and emits that many
/// `item`s joined by the spec's separator.
fn count(
    token: &str,
    rng: &mut SecureRng,
    item: impl FnMut(&mut SecureRng) -> String,
) -> Result<String, PasswordTemplateError> {
    Ok(CountSpec::parse(token, &token[1..], rng)?.build(item, rng))
}

/// A parsed count spec: how many items to emit and the phrase to join them with.
struct CountSpec {
    count: usize,
    join: String,
}

impl CountSpec {
    /// Parses `spec` (the part after the token letter) as a fixed `N`, a range
    /// `A-B`, or a range with a join phrase `A-B-sep`. The separator may itself
    /// contain `-`, so only the first two `-` are structural.
    fn parse(token: &str, spec: &str, rng: &mut SecureRng) -> Result<Self, PasswordTemplateError> {
        let invalid_number = || PasswordTemplateError::InvalidNumber(token.to_string());
        let mut parts = spec.splitn(3, '-');
        let lo = parts.next().unwrap_or(spec);

        match parts.next() {
            None => Ok(Self {
                count: lo.parse().map_err(|_| invalid_number())?,
                join: String::new(),
            }),
            Some(hi) => {
                let lo: usize = lo.parse().map_err(|_| invalid_number())?;
                let hi: usize = hi.parse().map_err(|_| invalid_number())?;
                if lo > hi {
                    return Err(PasswordTemplateError::InvalidRange(token.to_string()));
                }
                Ok(Self {
                    count: rng.random_range(lo..=hi),
                    join: parts.next().unwrap_or("").to_string(),
                })
            }
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
