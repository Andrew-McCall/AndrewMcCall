//! The Ukrainian reader: books read a sentence at a time.
//!
//! The reader types each word of the next sentence from a paper copy and is
//! shown what the word is and how it has been used so far. Everything shown
//! is plain data loaded by `tools/uk-import`; nothing is worked out here
//! beyond counting what the reader has already met (the `uk_seen` view).

use std::net::SocketAddr;

use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use sqlx::PgPool;
use ts_typegen::Ts;
use uuid::Uuid;

use crate::auth;
use crate::config::ApiConfig;
use crate::response::{self, ApiError, Body, ResponseBuilder};

type Req = Request<hyper::body::Incoming>;

const BODY_HINT: &str = "expected a JSON object";
const SESSION_CARDS: i64 = 20;
/// Sentence ids are `book id * BOOK_SPAN + place in the book`.
const BOOK_SPAN: i32 = 1_000_000;

#[derive(Serialize, Ts, sqlx::FromRow)]
struct UkExample {
    text: String,
    english: String,
}

#[derive(Serialize, Ts, sqlx::FromRow)]
struct UkWord {
    start: i32,
    form: String,
    accent: String,
    lemma: String,
    lemma_accent: String,
    part: String,
    gloss: String,
    tags: String,
    alts: Vec<String>,
    seen: i64,
    ahead: i64,
    #[sqlx(skip)]
    examples: Vec<UkExample>,
}

#[derive(Serialize, Ts, sqlx::FromRow)]
struct UkPhrase {
    first: i32,
    last: i32,
    kind: String,
    key: String,
    meaning: String,
    seen: i64,
    #[sqlx(skip)]
    examples: Vec<UkExample>,
}

#[derive(Serialize, Ts, sqlx::FromRow)]
struct UkSentence {
    id: i32,
    chapter: i32,
    text: String,
    english: String,
    literal: String,
    note: String,
    #[sqlx(skip)]
    words: Vec<UkWord>,
    #[sqlx(skip)]
    phrases: Vec<UkPhrase>,
    #[sqlx(skip)]
    similar: Vec<UkExample>,
}

#[derive(Serialize, Ts, sqlx::FromRow)]
struct UkChapter {
    id: i32,
    title: String,
    first: i32,
}

#[derive(Serialize, Ts, sqlx::FromRow)]
struct UkBook {
    id: i32,
    title: String,
}

#[derive(Serialize, Ts)]
struct UkState {
    books: Vec<UkBook>,
    book: i32,
    sentence: Option<UkSentence>,
    chapters: Vec<UkChapter>,
    total: i64,
    due: i64,
}

#[derive(Serialize, Ts, sqlx::FromRow)]
struct UkCard {
    lemma_id: i32,
    lemma: String,
    part: String,
    gloss: String,
    text: String,
    english: String,
    start: i32,
    form: String,
    accent: String,
}

#[derive(Deserialize)]
struct Done {
    sentence_id: i32,
    #[serde(default)]
    missed: Vec<i32>,
}

/// Opens a book, or jumps to a chapter of one.
#[derive(Deserialize)]
struct Goto {
    book: Option<i32>,
    chapter: Option<i32>,
}

#[derive(Deserialize)]
struct Answer {
    lemma_id: i32,
    ok: bool,
}

fn failed(err: sqlx::Error) -> ApiError {
    tracing::error!(error = %err, "ukrainian query failed");
    ApiError::Internal
}

fn respond<T: Serialize>(result: Result<T, ApiError>) -> hyper::Response<Body> {
    match result {
        Ok(value) => ResponseBuilder::new(StatusCode::OK).json(&value).into(),
        Err(err) => ResponseBuilder::from(err).into(),
    }
}

/// The reader's place: the book touched last, or the first book from its start.
async fn current(pool: &PgPool, user: Uuid) -> Result<Option<i32>, sqlx::Error> {
    let row: Option<(Option<i32>,)> = sqlx::query_as(
        "SELECT COALESCE((SELECT sentence_id FROM uk_progress WHERE user_id = $1 \
                          ORDER BY updated_at DESC LIMIT 1), \
                         (SELECT min(id) * $2 + 1 FROM uk_books))",
    )
    .bind(user)
    .bind(BOOK_SPAN)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(id,)| id))
}

const MOVE_TO: &str = "INSERT INTO uk_progress (user_id, book_id, sentence_id) \
     SELECT $1, id, $2 FROM uk_books WHERE id = $2 / 1000000 \
     ON CONFLICT (user_id, book_id) DO UPDATE \
     SET sentence_id = EXCLUDED.sentence_id, updated_at = now()";

/// Hands each `(position, example)` row to the item at that position.
fn attach<T>(
    items: &mut [T],
    rows: Vec<(i32, String, String)>,
    slot: impl Fn(&mut T) -> &mut Vec<UkExample>,
) {
    for (at, text, english) in rows {
        if let Some(item) = items.get_mut(at as usize) {
            slot(item).push(UkExample { text, english });
        }
    }
}

async fn load_sentence(
    pool: &PgPool,
    user: Uuid,
    id: i32,
) -> Result<Option<UkSentence>, sqlx::Error> {
    let Some(mut sentence): Option<UkSentence> = sqlx::query_as(
        "SELECT id, chapter, text, english, literal, note FROM uk_sentences WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    sentence.words = sqlx::query_as(
        "SELECT t.start, t.form, t.accent, l.lemma, l.accent AS lemma_accent, l.pos AS part, \
                l.gloss, t.tags, \
                ARRAY(SELECT a.lemma || ' (' || a.pos || ') ' || a.gloss FROM uk_lemmas a \
                      WHERE a.id = ANY (t.alts)) AS alts, \
                (SELECT count(*) FROM uk_tokens o JOIN uk_seen v USING (sentence_id) \
                 WHERE o.lemma_id = t.lemma_id AND v.user_id = $2) AS seen, \
                (SELECT count(*) FROM uk_tokens o WHERE o.lemma_id = t.lemma_id \
                 AND o.sentence_id > $1 AND o.sentence_id < ($1 / $3 + 1) * $3) AS ahead \
         FROM uk_tokens t JOIN uk_lemmas l ON l.id = t.lemma_id \
         WHERE t.sentence_id = $1 ORDER BY t.pos",
    )
    .bind(id)
    .bind(user)
    .bind(BOOK_SPAN)
    .fetch_all(pool)
    .await?;
    let examples = sqlx::query_as(
        "SELECT t.pos, s.text, s.english FROM uk_tokens t \
         CROSS JOIN LATERAL (SELECT DISTINCT o.sentence_id \
                             FROM uk_tokens o JOIN uk_seen v USING (sentence_id) \
                             WHERE o.lemma_id = t.lemma_id AND v.user_id = $2 \
                             ORDER BY o.sentence_id DESC LIMIT 2) o \
         JOIN uk_sentences s ON s.id = o.sentence_id \
         WHERE t.sentence_id = $1 ORDER BY t.pos, s.id DESC",
    )
    .bind(id)
    .bind(user)
    .fetch_all(pool)
    .await?;
    attach(&mut sentence.words, examples, |word| &mut word.examples);

    sentence.phrases = sqlx::query_as(
        "SELECT h.first_pos AS first, h.last_pos AS last, p.kind, p.key, p.meaning, \
                (SELECT count(*) FROM uk_phrase_hits o JOIN uk_seen v USING (sentence_id) \
                 WHERE o.phrase_id = h.phrase_id AND v.user_id = $2) AS seen \
         FROM uk_phrase_hits h JOIN uk_phrases p ON p.id = h.phrase_id \
         WHERE h.sentence_id = $1 ORDER BY h.first_pos, h.phrase_id",
    )
    .bind(id)
    .bind(user)
    .fetch_all(pool)
    .await?;
    let examples = sqlx::query_as(
        "SELECT h.at, o.text, o.english \
         FROM (SELECT phrase_id, \
                      (row_number() OVER (ORDER BY first_pos, phrase_id) - 1)::int AS at \
               FROM uk_phrase_hits WHERE sentence_id = $1) h \
         CROSS JOIN LATERAL (SELECT DISTINCT s.id, s.text, s.english \
                             FROM uk_phrase_hits e JOIN uk_seen v USING (sentence_id) \
                             JOIN uk_sentences s ON s.id = e.sentence_id \
                             WHERE e.phrase_id = h.phrase_id AND v.user_id = $2 \
                             ORDER BY s.id DESC LIMIT 2) o",
    )
    .bind(id)
    .bind(user)
    .fetch_all(pool)
    .await?;
    attach(&mut sentence.phrases, examples, |phrase| &mut phrase.examples);

    // A one- or two-word sentence shares its shape with too many others to teach anything.
    sentence.similar = sqlx::query_as(
        "SELECT o.text, o.english FROM uk_sentences s \
         JOIN uk_sentences o ON o.pattern = s.pattern \
         JOIN uk_seen v ON v.sentence_id = o.id AND v.user_id = $2 \
         WHERE s.id = $1 AND s.pattern LIKE '% % %' ORDER BY o.id DESC LIMIT 3",
    )
    .bind(id)
    .bind(user)
    .fetch_all(pool)
    .await?;

    Ok(Some(sentence))
}

async fn load_state(pool: &PgPool, user: Uuid) -> Result<UkState, sqlx::Error> {
    let place = current(pool, user).await?.unwrap_or(0);
    let book = place / BOOK_SPAN;
    let sentence = load_sentence(pool, user, place).await?;
    let books = sqlx::query_as("SELECT id, title FROM uk_books ORDER BY id")
        .fetch_all(pool)
        .await?;
    let chapters = sqlx::query_as(
        "SELECT c.id, c.title, min(s.id) AS first FROM uk_chapters c \
         JOIN uk_sentences s ON s.chapter = c.id WHERE c.book_id = $1 \
         GROUP BY c.id ORDER BY c.id",
    )
    .bind(book)
    .fetch_all(pool)
    .await?;
    let (total, due): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM uk_sentences WHERE id / $3 = $2), \
                (SELECT count(*) FROM uk_reviews r WHERE r.user_id = $1 AND r.due <= now() \
                 AND EXISTS (SELECT 1 FROM uk_tokens o JOIN uk_seen v USING (sentence_id) \
                             WHERE o.lemma_id = r.lemma_id AND v.user_id = r.user_id))",
    )
    .bind(user)
    .bind(book)
    .bind(BOOK_SPAN)
    .fetch_one(pool)
    .await?;
    Ok(UkState { books, book, sentence, chapters, total, due })
}

async fn mark_done(pool: &PgPool, user: Uuid, done: &Done) -> Result<(), sqlx::Error> {
    if Some(done.sentence_id) != current(pool, user).await? {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    // The last sentence has no successor to move to, so its place is written directly.
    sqlx::query(
        "INSERT INTO uk_progress (user_id, book_id, sentence_id) VALUES ($1, $2 / $3, $2 + 1) \
         ON CONFLICT (user_id, book_id) DO UPDATE \
         SET sentence_id = EXCLUDED.sentence_id, updated_at = now()",
    )
    .bind(user)
    .bind(done.sentence_id)
    .bind(BOOK_SPAN)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO uk_reviews (user_id, lemma_id, due) \
         SELECT $1, t.lemma_id, now() + interval '1 day' \
         FROM uk_tokens t JOIN uk_lemmas l ON l.id = t.lemma_id \
         WHERE t.sentence_id = $2 AND l.pos NOT IN ('name', 'x') \
         ON CONFLICT DO NOTHING",
    )
    .bind(user)
    .bind(done.sentence_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE uk_reviews SET stage = 0, due = now() \
         WHERE user_id = $1 AND lemma_id IN (SELECT lemma_id FROM uk_tokens \
                                             WHERE sentence_id = $2 AND pos = ANY ($3))",
    )
    .bind(user)
    .bind(done.sentence_id)
    .bind(&done.missed)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// `GET /uk`: the reader's next sentence with everything taught about it.
pub async fn state(req: Req, peer: SocketAddr, config: &ApiConfig) -> hyper::Response<Body> {
    respond(
        async {
            let user = auth::authenticate(&req, peer, config).await?;
            load_state(&config.db.pool(), user.id).await.map_err(failed)
        }
        .await,
    )
}

/// `POST /uk/done`: the sentence was typed to the end. Its words join the
/// review pile and the ones in `missed` come up first.
pub async fn done(req: Req, config: &ApiConfig) -> hyper::Response<Body> {
    respond(
        async {
            let user = auth::authenticate_quiet(&req, config).await?;
            let done: Done = response::read_json(req, BODY_HINT).await?;
            let pool = config.db.pool();
            mark_done(&pool, user.id, &done).await.map_err(failed)?;
            load_state(&pool, user.id).await.map_err(failed)
        }
        .await,
    )
}

/// `POST /uk/goto`: open a book where the reader left it, or move to the
/// first sentence of a chapter.
pub async fn goto(req: Req, config: &ApiConfig) -> hyper::Response<Body> {
    respond(
        async {
            let user = auth::authenticate_quiet(&req, config).await?;
            let goto: Goto = response::read_json(req, BODY_HINT).await?;
            let pool = config.db.pool();
            let target: (Option<i32>,) = sqlx::query_as(
                "SELECT COALESCE((SELECT min(id) FROM uk_sentences WHERE chapter = $2), \
                                 (SELECT sentence_id FROM uk_progress \
                                  WHERE user_id = $1 AND book_id = $3), \
                                 (SELECT id * $4 + 1 FROM uk_books WHERE id = $3))",
            )
            .bind(user.id)
            .bind(goto.chapter)
            .bind(goto.book)
            .bind(BOOK_SPAN)
            .fetch_one(&pool)
            .await
            .map_err(failed)?;
            sqlx::query(MOVE_TO)
                .bind(user.id)
                .bind(target.0)
                .execute(&pool)
                .await
                .map_err(failed)?;
            load_state(&pool, user.id).await.map_err(failed)
        }
        .await,
    )
}

/// `GET /uk/review`: due words, the most common in the book first, each inside
/// a sentence the reader has already typed.
pub async fn cards(req: Req, config: &ApiConfig) -> hyper::Response<Body> {
    respond(
        async {
            let user = auth::authenticate_quiet(&req, config).await?;
            let pool = config.db.pool();
            let cards: Vec<UkCard> = sqlx::query_as(
                "SELECT r.lemma_id, l.lemma, l.pos AS part, l.gloss, s.text, s.english, t.start, t.form, \
                        t.accent \
                 FROM uk_reviews r JOIN uk_lemmas l ON l.id = r.lemma_id \
                 CROSS JOIN LATERAL (SELECT o.sentence_id, o.start, o.form, o.accent \
                                     FROM uk_tokens o JOIN uk_seen v USING (sentence_id) \
                                     WHERE o.lemma_id = r.lemma_id AND v.user_id = r.user_id \
                                     ORDER BY random() LIMIT 1) t \
                 JOIN uk_sentences s ON s.id = t.sentence_id \
                 WHERE r.user_id = $1 AND r.due <= now() \
                 ORDER BY (SELECT count(*) FROM uk_tokens c WHERE c.lemma_id = r.lemma_id) DESC, \
                          r.lemma_id \
                 LIMIT $2",
            )
            .bind(user.id)
            .bind(SESSION_CARDS)
            .fetch_all(&pool)
            .await
            .map_err(failed)?;
            Ok(cards)
        }
        .await,
    )
}

/// `POST /uk/review`: a right answer pushes the word further out; a wrong one
/// brings it back in ten minutes.
pub async fn answer(req: Req, config: &ApiConfig) -> hyper::Response<Body> {
    let result = async {
        let user = auth::authenticate_quiet(&req, config).await?;
        let answer: Answer = response::read_json(req, BODY_HINT).await?;
        sqlx::query(
            "UPDATE uk_reviews SET \
                stage = CASE WHEN $3 THEN stage + 1 ELSE 0 END, \
                due = now() + CASE WHEN $3 \
                    THEN (ARRAY[3, 7, 16, 35, 80, 180, 365])[LEAST(stage + 1, 7)] * interval '1 day' \
                    ELSE interval '10 minutes' END \
             WHERE user_id = $1 AND lemma_id = $2",
        )
        .bind(user.id)
        .bind(answer.lemma_id)
        .bind(answer.ok)
        .execute(&config.db.pool())
        .await
        .map_err(failed)
    };
    match result.await {
        Ok(_) => ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into(),
        Err(err) => ResponseBuilder::from(err).into(),
    }
}
