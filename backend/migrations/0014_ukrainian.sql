-- The Ukrainian reader: books cut into sentences and words, plus what is
-- taught about each. Everything except `uk_progress` and `uk_reviews` is
-- written by `tools/uk-import` (`book.py` for the text, `lessons.py` for what is
-- taught); the backend only reads it.
--
-- A sentence id is `book id * 1000000 + its place in the book`, so ids sort in
-- reading order and one range holds one book. Words and phrases are shared by
-- all books.

CREATE TABLE IF NOT EXISTS uk_books (
    id    INT PRIMARY KEY,
    title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uk_chapters (
    id      INT PRIMARY KEY,
    book_id INT NOT NULL REFERENCES uk_books (id) ON DELETE CASCADE,
    title   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uk_lemmas (
    id     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lemma  TEXT NOT NULL,
    pos    TEXT NOT NULL,
    accent TEXT NOT NULL DEFAULT '',
    gloss  TEXT NOT NULL DEFAULT '',
    UNIQUE (lemma, pos)
);

-- `english`, `literal` and `note` are the lesson, empty until one is written.
CREATE TABLE IF NOT EXISTS uk_sentences (
    id      INT PRIMARY KEY,
    chapter INT NOT NULL REFERENCES uk_chapters (id) ON DELETE CASCADE,
    text    TEXT NOT NULL,
    pattern TEXT NOT NULL DEFAULT '',
    english TEXT NOT NULL DEFAULT '',
    literal TEXT NOT NULL DEFAULT '',
    note    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS uk_sentences_pattern_idx ON uk_sentences (pattern, id);

-- `start` is the word's UTF-16 offset in the sentence text. `tags` holds the
-- readings still possible for the chosen lemma, most likely first, joined by
-- `|`. `alts` names other lemmas the form could belong to.
CREATE TABLE IF NOT EXISTS uk_tokens (
    sentence_id INT NOT NULL REFERENCES uk_sentences (id) ON DELETE CASCADE,
    pos         INT NOT NULL,
    start       INT NOT NULL,
    form        TEXT NOT NULL,
    accent      TEXT NOT NULL DEFAULT '',
    lemma_id    INT NOT NULL REFERENCES uk_lemmas (id),
    tags        TEXT NOT NULL DEFAULT '',
    alts        INT[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (sentence_id, pos)
);

CREATE INDEX IF NOT EXISTS uk_tokens_lemma_idx ON uk_tokens (lemma_id, sentence_id);

-- Anything taught about more than one word: an idiom, a pair of words that
-- keep company, or a grammar construction such as "на + accusative".
CREATE TABLE IF NOT EXISTS uk_phrases (
    id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind    TEXT NOT NULL,
    key     TEXT NOT NULL UNIQUE,
    meaning TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS uk_phrase_hits (
    phrase_id   INT NOT NULL REFERENCES uk_phrases (id) ON DELETE CASCADE,
    sentence_id INT NOT NULL REFERENCES uk_sentences (id) ON DELETE CASCADE,
    first_pos   INT NOT NULL,
    last_pos    INT NOT NULL,
    PRIMARY KEY (phrase_id, sentence_id, first_pos)
);

CREATE INDEX IF NOT EXISTS uk_phrase_hits_sentence_idx ON uk_phrase_hits (sentence_id);

-- The next sentence to read in each book. Every sentence before it counts as
-- seen. The book touched last is the one the reader opens on.
CREATE TABLE IF NOT EXISTS uk_progress (
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id     INT NOT NULL REFERENCES uk_books (id) ON DELETE CASCADE,
    sentence_id INT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, book_id)
);

-- Every sentence a reader has passed, in any book.
CREATE OR REPLACE VIEW uk_seen AS
    SELECT p.user_id, s.id AS sentence_id
    FROM uk_progress p
    JOIN uk_sentences s ON s.id > p.book_id * 1000000 AND s.id < p.sentence_id;

CREATE TABLE IF NOT EXISTS uk_reviews (
    user_id  UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    lemma_id INT NOT NULL REFERENCES uk_lemmas (id) ON DELETE CASCADE,
    stage    INT NOT NULL DEFAULT 0,
    due      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, lemma_id)
);

CREATE INDEX IF NOT EXISTS uk_reviews_due_idx ON uk_reviews (user_id, due);
