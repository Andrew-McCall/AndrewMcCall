#!/usr/bin/env python3
"""Turns a lesson file into SQL for the uk_* tables.

    lessons.py lessons.json > lessons.sql

The file is one JSON object, every part optional:

    {"glosses":   [{"lemma": "хата", "pos": "noun", "gloss": "house"}],
     "phrases":   [{"key": "махнути рука", "meaning": "to give up on"}],
     "sentences": [{"id": 1000006, "en": "...", "lit": "...", "note": "...",
                    "words": {"2": {"tags": "noun:anim:m:v_naz",
                                    "lemma": "хата", "pos": "noun"}},
                    "phrases": [{"first": 0, "last": 1, "key": "...",
                                 "meaning": "...", "kind": "idiom"}]}]}

A gloss replaces the dictionary's. `words` corrects the reading of the word at
that place: its tags, its lemma, or both; a lemma without a pos keeps the
word's current pos. A phrase inside a sentence is marked on those words; a
phrase at the top is not. A phrase's `meaning` and `kind` are optional: what is
left out stays as it was, and a new phrase is an idiom.
"""

import json
import sys

from book import copy


def main(path, out=sys.stdout):
    lessons = json.load(open(path, encoding="utf-8"))
    sentences = lessons.get("sentences", [])
    phrases = [(p["key"], p.get("kind"), p.get("meaning", ""), None, 0, 0)
               for p in lessons.get("phrases", [])]
    phrases += [(p["key"], p.get("kind"), p.get("meaning", ""), s["id"], p["first"], p["last"])
                for s in sentences for p in s.get("phrases", [])]

    out.write("BEGIN;\n")
    copy(out, "l_glosses", "lemma text, pos text, gloss text",
         ((g["lemma"], g["pos"], g["gloss"]) for g in lessons.get("glosses", [])))
    copy(out, "l_sentences", "id int, english text, literal text, note text",
         ((s["id"], s.get("en", ""), s.get("lit", ""), s.get("note", "")) for s in sentences))
    copy(out, "l_words", "sentence_id int, pos int, tags text, lemma text, lpos text",
         ((s["id"], pos, w.get("tags", ""), w.get("lemma", ""), w.get("pos", ""))
          for s in sentences for pos, w in s.get("words", {}).items()))
    copy(out, "l_phrases", "key text, kind text, meaning text, sentence_id int, "
         "first_pos int, last_pos int", phrases)
    out.write("""
INSERT INTO uk_lemmas (lemma, pos, gloss) SELECT * FROM l_glosses
    ON CONFLICT (lemma, pos) DO UPDATE SET gloss = EXCLUDED.gloss;
UPDATE uk_sentences s SET
    english = COALESCE(NULLIF(l.english, ''), s.english),
    literal = COALESCE(NULLIF(l.literal, ''), s.literal),
    note = COALESCE(NULLIF(l.note, ''), s.note)
    FROM l_sentences l WHERE s.id = l.id;
UPDATE l_words w SET lpos = l.pos
    FROM uk_tokens t JOIN uk_lemmas l ON l.id = t.lemma_id
    WHERE w.lpos = '' AND t.sentence_id = w.sentence_id AND t.pos = w.pos;
INSERT INTO uk_lemmas (lemma, pos) SELECT DISTINCT lemma, lpos FROM l_words WHERE lemma <> ''
    ON CONFLICT DO NOTHING;
UPDATE uk_tokens t SET
    tags = COALESCE(NULLIF(w.tags, ''), t.tags),
    lemma_id = COALESCE((SELECT id FROM uk_lemmas WHERE lemma = w.lemma AND pos = w.lpos),
                        t.lemma_id),
    alts = '{}'
    FROM l_words w WHERE t.sentence_id = w.sentence_id AND t.pos = w.pos;
INSERT INTO uk_phrases (key, kind, meaning)
    SELECT DISTINCT ON (key) key, COALESCE(kind, 'idiom'), meaning FROM l_phrases
    ORDER BY key, meaning = ''
    ON CONFLICT (key) DO UPDATE
    SET meaning = COALESCE(NULLIF(EXCLUDED.meaning, ''), uk_phrases.meaning);
UPDATE uk_phrases p SET kind = l.kind FROM l_phrases l WHERE l.key = p.key AND l.kind IS NOT NULL;
INSERT INTO uk_phrase_hits (phrase_id, sentence_id, first_pos, last_pos)
    SELECT p.id, l.sentence_id, l.first_pos, l.last_pos
    FROM l_phrases l JOIN uk_phrases p ON p.key = l.key WHERE l.sentence_id IS NOT NULL
    ON CONFLICT DO NOTHING;
COMMIT;
""")


if __name__ == "__main__":
    main(sys.argv[1])
