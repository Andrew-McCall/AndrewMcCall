#!/usr/bin/env python3
"""Turns a Ukrainian EPUB and two offline dictionaries into SQL for the uk_* tables.

    book.py 1 "Title" book.epub dict_corp_vis.txt kaikki-uk.jsonl > book.sql

The number is the book's id: a new one adds a book, a used one loads that book
again. dict_corp_vis.txt is the VESUM form dictionary (github.com/brown-uk/dict_uk
releases). kaikki-uk.jsonl is the Wiktionary extract from
kaikki.org/dictionary/Ukrainian. Running it again keeps reader progress and
glosses. It resets each word's reading and the phrase marks, and it drops the
lesson of any sentence whose text changed, so a lesson can never sit under the
wrong sentence: run lessons.py on the book's lesson files afterwards.
"""

import argparse
import collections
import html
import json
import math
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

PART = re.compile(r"^частина\b", re.I)
BOOK_SPAN = 1_000_000
WORD = re.compile(r"[^\W\d_]+(?:[-'’ʼ][^\W\d_]+)*")
SENTENCE_END = re.compile(
    r"(?:(?<=[.!?…])|(?<=[.!?…][\"»”)]))\s+(?=[—«\"„(]?\s?[А-ЯЇІЄҐ])"
)
CLAUSE_BREAK = re.compile(r"[,.;:!?…—()\"«»]")
ACUTE = "\u0301"

CASES = ["naz", "zna", "rod", "dav", "oru", "mis", "kly"]
CASE_NAME = {
    "naz": "nominative", "zna": "accusative", "rod": "genitive", "dav": "dative",
    "oru": "instrumental", "mis": "locative", "kly": "vocative",
}
NOMINAL = ("noun", "adj", "numr")
TAG_COST = {"bad": 6, "obsc": 6, "abbr": 5, "nv": 4, "vulg": 4, "arch": 3,
            "subst": 3, "alt": 2, "rare": 2, "slang": 1}
POS_RANK = ["prep", "conj", "part", "pron", "pred", "num", "adv", "verb",
            "advp", "noun", "adj", "intj", "name", "x"]
PREFER = {"це": "pron", "все": "pron", "як": "conj", "коли": "conj", "а": "conj",
          "так": "adv", "ще": "adv", "вже": "adv", "уже": "adv", "там": "adv",
          "тут": "adv", "де": "adv", "тільки": "part", "до": "prep", "мов": "conj"}
CONTENT = {"noun", "verb", "adj", "adv"}
KAIKKI_POS = {"noun": ["noun"], "name": ["name", "noun"], "verb": ["verb"],
              "adj": ["adj"], "adv": ["adv"], "pron": ["pron", "det"],
              "num": ["num"], "prep": ["prep"], "conj": ["conj"],
              "part": ["particle"], "intj": ["intj"]}

# Which cases a preposition takes, and what the pair means.
GOVERN = {
    "в": {"zna": "into, to (motion); on (a day)", "mis": "in, at (place)", "rod": "at someone's; someone has"},
    "на": {"zna": "onto, to (motion); for (a time or purpose)", "mis": "on, at (place)"},
    "з": {"rod": "from, out of; since", "oru": "with, together with"},
    "до": {"rod": "to, towards; until"},
    "від": {"rod": "from, away from"},
    "для": {"rod": "for"},
    "без": {"rod": "without"},
    "біля": {"rod": "near, by"},
    "коло": {"rod": "near, around"},
    "після": {"rod": "after"},
    "серед": {"rod": "among, in the middle of"},
    "проти": {"rod": "against, opposite"},
    "крім": {"rod": "except, besides"},
    "замість": {"rod": "instead of"},
    "навколо": {"rod": "around"},
    "з-за": {"rod": "from behind; because of"},
    "з-під": {"rod": "from under"},
    "за": {"zna": "for, in exchange for; behind (motion); in (a time)", "oru": "behind, beyond; after, following"},
    "під": {"zna": "under (motion)", "oru": "under (place)"},
    "над": {"oru": "over, above"},
    "перед": {"oru": "in front of, before"},
    "між": {"oru": "between, among", "rod": "between, among"},
    "по": {"mis": "along, around, through; by", "zna": "up to; to fetch"},
    "при": {"mis": "at, by, in the presence of"},
    "про": {"zna": "about"},
    "через": {"zna": "across, through; because of; in (a time from now)"},
    "крізь": {"zna": "through"},
    "о": {"mis": "at (an hour)", "zna": "against"},
}
PREP_ALIAS = {"у": "в", "із": "з", "зі": "з", "зо": "з", "од": "від", "об": "о",
              "побіля": "біля", "окрім": "крім", "із-за": "з-за", "із-під": "з-під"}


def norm(word):
    return re.sub("[’ʼ]", "'", word.replace(ACUTE, "")).lower()


def paragraphs(epub):
    book = zipfile.ZipFile(epub)
    opf = next(name for name in book.namelist() if name.endswith(".opf"))
    root = ET.fromstring(book.read(opf))
    ns = {"o": "http://www.idpf.org/2007/opf"}
    href = {item.get("id"): item.get("href") for item in root.iterfind(".//o:item", ns)}
    for ref in root.iterfind(".//o:itemref", ns):
        page = book.read(posixpath.join(posixpath.dirname(opf), href[ref.get("idref")]))
        for match in re.finditer(r"<(p|h[1-6])\b[^>]*>(.*?)</\1>", page.decode("utf-8"), re.S):
            text = html.unescape(re.sub(r"<[^>]+>", "", match.group(2)))
            # Printed stress marks go: a word is stored as it is typed.
            yield " ".join(re.sub(r"\[\d+\]", "", text).replace(ACUTE, "").split())


def read_book(epub, heading, end, book_title):
    """Yields (chapter title, [sentence]) from the first heading to the end marker.

    A book with no headings is one chapter named after the book.
    """
    texts = list(paragraphs(epub))
    part, title, sentences = "", None, []
    if not any(heading.match(t) for t in texts):
        title = book_title
    for text in texts:
        if text == end:
            break
        if heading.match(text):
            if title:
                yield title, sentences
            # Only the first word changes case, so a Roman numeral stays one.
            first, _, rest = text.partition(" ")
            name = f"{first.capitalize()} {rest.lower() if PART.match(text) else rest}".strip()
            if PART.match(text):
                part, title = name, name
            else:
                title = f"{part} · {name}" if part else name
            sentences = []
        elif title and WORD.search(text):
            sentences += [s for s in SENTENCE_END.split(text) if WORD.search(s)]
    if title:
        yield title, sentences


def read_kaikki(path):
    """word -> [{pos, gloss, accent: {plain form: stressed form}}]"""
    entries = collections.defaultdict(list)
    for line in open(path, encoding="utf-8"):
        raw = json.loads(line)
        glosses = [s["glosses"][-1] for s in raw.get("senses", [])
                   if s.get("glosses") and "form_of" not in s]
        if not glosses:
            continue
        accent, partner = {}, ""
        for form in raw.get("forms", []):
            text, tags = form.get("form", ""), form.get("tags", [])
            if ACUTE in text:
                accent.setdefault(norm(text), text)
            if tags in (["perfective"], ["imperfective"]):
                partner = f" ({tags[0]}: {text})"
        gloss = "; ".join(glosses[:3])
        entries[raw["word"]].append(
            {"pos": raw["pos"], "gloss": gloss[:200] + partner, "accent": accent}
        )
    return entries


def read_vesum(path, wanted):
    """normalised form -> [(lemma, tags)] for the forms we need."""
    found, lemma = collections.defaultdict(list), ""
    for line in open(path, encoding="utf-8"):
        parts = line.split()
        if len(parts) < 2:
            continue
        if not line.startswith(" "):
            lemma = parts[0]
        key = norm(parts[0])
        if key in wanted:
            found[key].append((lemma, parts[1]))
    return found


def coarse(tags):
    parts = tags.split(":")
    if "pron" in parts:
        return "pron"
    if "prop" in parts:
        return "name"
    if parts[0] == "noninfl":
        return "pred" if "predic" in parts else "x"
    return {"numr": "num", "number": "num"}.get(parts[0], parts[0])


def case_of(tags):
    return next((p[2:] for p in tags.split(":") if p.startswith("v_")), None)


def agreement(tags):
    parts = tags.split(":")
    number = "p" if "p" in parts else next((p for p in parts if p in "mfn"), "")
    return number, case_of(tags)


GLOSSED = set()


def cost(lemma, tags, form):
    parts = tags.split(":")
    pos = coarse(tags)
    rank = 0 if PREFER.get(form) == pos else POS_RANK.index(pos) + 1
    unknown = 0 if lemma in GLOSSED or lemma.lower() in GLOSSED else 14
    return 20 * sum(TAG_COST.get(p, 0) for p in parts) + unknown + rank


class Token:
    def __init__(self, match, start, before, after, readings, is_name):
        self.form, self.start = match.group(), start
        self.key = norm(self.form)
        self.gap = bool(CLAUSE_BREAK.search(before)) or not before
        self.called = after in (",", "!", "?")
        self.is_name = is_name
        named = [r for r in readings if "prop" in r[1].split(":")]
        plain = [r for r in readings if r not in named]
        if is_name:
            readings = named
        elif self.form[0].islower() and plain:
            readings = plain
        self.readings = readings
        self.governed = False

    def keep(self, test):
        kept = [r for r in self.readings if test(r)]
        if kept:
            self.readings = kept

    def nominal(self):
        return [r for r in self.readings if r[1].startswith(NOMINAL)]

    def best(self):
        return min(self.readings, key=lambda r: cost(*r, self.key), default=None)

    def lemma(self):
        best = self.best()
        if best:
            return best[0], coarse(best[1])
        return (self.form, "name") if self.is_name else (self.key, "x")

    def tags(self):
        chosen = self.lemma()
        mine = [t for l, t in self.readings if (l, coarse(t)) == chosen]
        order = lambda t: CASES.index(case_of(t)) if case_of(t) else 0
        short = [":".join(p for p in t.split(":") if not p.startswith(("xp", "r")) or p == "rev")
                 for t in sorted(mine, key=order)]
        return list(dict.fromkeys(short))[:4]

    def alts(self):
        chosen, limit = self.lemma(), cost(*self.best(), self.key) + 40 if self.readings else 0
        others = {(l, coarse(t)) for l, t in self.readings if cost(l, t, self.key) <= limit}
        return sorted(others - {chosen})[:3]

    def case(self):
        cases = {case_of(t) for t in self.tags()}
        return cases.pop() if len(cases) == 1 else None


def preposition(token):
    if token.readings and token.lemma()[1] == "prep":
        return PREP_ALIAS.get(token.key, token.key)
    return None


def govern(tokens):
    """Narrows the words after a preposition to its cases; returns (prep index, noun index)."""
    spans = []
    for i, token in enumerate(tokens):
        allowed = GOVERN.get(preposition(token))
        if not allowed:
            continue
        for j in range(i + 1, min(i + 5, len(tokens))):
            word = tokens[j]
            if word.gap or not word.nominal():
                break
            word.keep(lambda r: not r[1].startswith(NOMINAL) or case_of(r[1]) in allowed)
            word.governed = True
            if word.best()[1].startswith("noun"):
                spans.append((i, j))
                break
    return spans


def disambiguate(tokens):
    spans = govern(tokens)
    for token in tokens:
        if not token.governed:
            token.keep(lambda r: case_of(r[1]) != "mis")
        if not (token.called and token.lemma()[1] in ("noun", "name")):
            token.keep(lambda r: case_of(r[1]) != "kly")
    for left, right in zip(tokens, tokens[1:]):
        adjectives = {agreement(t) for _, t in left.readings if t.startswith("adj")}
        nouns = {agreement(t) for _, t in right.readings if t.startswith("noun")}
        shared = adjectives & nouns
        if shared and not right.gap:
            left.keep(lambda r: not r[1].startswith("adj") or agreement(r[1]) in shared)
            right.keep(lambda r: not r[1].startswith("noun") or agreement(r[1]) in shared)
    return spans


def grammar_hits(tokens, spans):
    for first, last in spans:
        prep, case = preposition(tokens[first]), tokens[last].case()
        if case in GOVERN[prep]:
            yield f"{prep} + {CASE_NAME[case]}", GOVERN[prep][case], first, last
    for i, token in enumerate(tokens):
        tags = "|".join(token.tags())
        if token.lemma() == ("бути", "verb") and "futr" in tags:
            for j in range(i + 1, min(i + 3, len(tokens))):
                if ":inf" in "|".join(tokens[j].tags()):
                    yield ("буду + infinitive", "will do, will be doing: the future of "
                           "an imperfective verb", i, j)
                    break
        if token.key in ("б", "би"):
            near = [j for j in (i - 1, i + 1, i - 2, i + 2) if 0 <= j < len(tokens)
                    and ":past" in "|".join(tokens[j].tags())]
            if near:
                yield ("past + б/би", "would: the conditional is a past form plus б "
                       "(after a vowel) or би", min(i, near[0]), max(i, near[0]))


def pattern(tokens):
    parts = []
    for token in tokens:
        tags = token.tags()[0].split(":") if token.tags() else []
        detail = token.case() or next((t for t in tags if t in ("inf", "past", "pres", "futr", "impr")), "")
        parts.append(token.lemma()[1] + ("." + detail if detail else ""))
    return " ".join(parts)


def idiom_index(kaikki, vesum):
    """first word -> [(word sets, phrase, meaning)] for the multi-word dictionary entries.

    A word given in its dictionary form matches any of its forms; an inflected
    or very short word matches only as written.
    """
    index = collections.defaultdict(list)
    for phrase, entries in kaikki.items():
        words = [norm(w) for w in WORD.findall(phrase)]
        entry = next((e for e in entries if e["pos"] not in ("name", "num")), None)
        if len(words) < 2 or not entry or max(map(len, words)) < 3:
            continue
        sets = []
        for word in words:
            lemmas = {norm(l) for l, _ in vesum.get(word, [])}
            sets.append({word} | (lemmas if word in lemmas and len(word) > 3 else set()))
        for first in sets[0]:
            index[first].append((sets, phrase, entry["gloss"]))
    return index


def idiom_hits(tokens, index):
    names = [{t.key} | {norm(l) for l, _ in t.readings if len(t.key) > 3} for t in tokens]
    for i, first in enumerate(names):
        for sets, phrase, meaning in {id(c): c for n in first for c in index.get(n, [])}.values():
            span = names[i : i + len(sets)]
            if len(span) == len(sets) and all(a & b for a, b in zip(span, sets)):
                yield phrase, meaning, i, i + len(sets) - 1


def pair_phrases(book):
    """Neighbouring content words that meet far more often than chance."""
    singles, pairs = collections.Counter(), collections.Counter()
    for tokens in book:
        lemmas = [t.lemma() for t in tokens]
        singles.update(lemmas)
        for (a, b), right in zip(zip(lemmas, lemmas[1:]), tokens[1:]):
            if not right.gap and a[1] in CONTENT and b[1] in CONTENT and a != b:
                pairs[a, b] += 1
    total = sum(singles.values())
    return {
        (a, b): f"{a[0]} {b[0]}"
        for (a, b), count in pairs.items()
        if count >= 5 and math.log2(count * total / (singles[a] * singles[b])) >= 7
    }


def gloss_for(lemma, pos, kaikki):
    entries = kaikki.get(lemma) or kaikki.get(lemma.lower()) or []
    wanted = KAIKKI_POS.get(pos, [])
    entry = next((e for e in entries if e["pos"] in wanted), entries[0] if entries else None)
    return entry or {"gloss": "", "accent": {}}


def copy(out, table, columns, rows):
    out.write(f"CREATE TEMP TABLE {table} ({columns}) ON COMMIT DROP;\nCOPY {table} FROM stdin;\n")
    for row in rows:
        cells = ("\\N" if c is None else
                 str(c).replace("\\", "\\\\").replace("\t", " ").replace("\n", " ") for c in row)
        out.write("\t".join(cells) + "\n")
    out.write("\\.\n")


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def tokenize(text, vesum, names):
    matches = list(WORD.finditer(text))
    ends = [0] + [m.end() for m in matches]
    return [
        Token(m, utf16_length(text[: m.start()]), text[end : m.start()],
              text[m.end() : m.end() + 1],
              vesum.get(norm(m.group()), []), norm(m.group()) in names)
        for m, end in zip(matches, ends)
    ]


def find_names(texts):
    """Words that are capitalised inside a sentence and never written small."""
    inside, small = collections.Counter(), set()
    for text in texts:
        for i, match in enumerate(WORD.finditer(text)):
            word = match.group()
            if word[0].islower():
                small.add(norm(word))
            elif i and not re.search(r"[.!?…:\"«—]", text[max(0, match.start() - 3) : match.start()]):
                inside[norm(word)] += 1
    return {word for word, count in inside.items() if count >= 2 and word not in small}


def main(args, out=sys.stdout):
    heading = re.compile(args.heading, re.I)
    chapters = list(read_book(args.epub, heading, args.end, args.title))
    kaikki_path, vesum_path, base = args.kaikki, args.vesum, args.book * BOOK_SPAN
    kaikki = read_kaikki(kaikki_path)
    GLOSSED.update(kaikki)
    names = find_names(s for _, ss in chapters for s in ss)
    wanted = {norm(m.group()) for _, ss in chapters for s in ss for m in WORD.finditer(s)}
    wanted |= {norm(w) for phrase in kaikki if " " in phrase for w in WORD.findall(phrase)}
    vesum = read_vesum(vesum_path, wanted)
    idioms = idiom_index(kaikki, vesum)

    book, sentences, hits, phrases = [], [], [], {}
    for chapter, (_, texts) in enumerate(chapters, 1):
        for text in texts:
            tokens = tokenize(text, vesum, names)
            spans = disambiguate(tokens)
            sid = base + len(book) + 1
            for key, meaning, first, last in grammar_hits(tokens, spans):
                phrases[key] = ("grammar", meaning)
                hits.append((key, sid, first, last))
            for key, meaning, first, last in idiom_hits(tokens, idioms):
                phrases[key] = ("idiom", meaning)
                hits.append((key, sid, first, last))
            book.append(tokens)
            sentences.append((sid, args.book * 1000 + chapter, text, pattern(tokens)))

    pairs = pair_phrases(book)
    taken = {(sid, pos) for key, sid, first, last in hits if phrases[key][0] == "idiom"
             for pos in range(first, last + 1)}
    for sid, tokens in enumerate(book, base + 1):
        for i, (left, right) in enumerate(zip(tokens, tokens[1:])):
            key = pairs.get((left.lemma(), right.lemma()))
            if key and not right.gap and key not in phrases and (sid, i) not in taken:
                hits.append((key, sid, i, i + 1))
    used = {key for key, *_ in hits}
    phrases.update({key: ("pair", "") for key in pairs.values() if key in used and key not in phrases})

    lemmas, token_rows = {}, []
    for sid, tokens in enumerate(book, base + 1):
        for i, token in enumerate(tokens):
            lemma = token.lemma()
            entry = gloss_for(*lemma, kaikki)
            lemmas[lemma] = (entry["accent"].get(norm(lemma[0]), ""), entry["gloss"])
            for other in token.alts():
                lemmas.setdefault(other, ("", gloss_for(*other, kaikki)["gloss"]))
            alts = ";".join(f"{l}/{p}" for l, p in token.alts())
            token_rows.append((sid, i, token.start, token.form, entry["accent"].get(token.key, ""),
                               *lemma, "|".join(token.tags()), alts))

    out.write("BEGIN;\n")
    copy(out, "s_books", "id int, title text", [(args.book, args.title)])
    copy(out, "s_chapters", "id int, book_id int, title text",
         ((args.book * 1000 + i, args.book, t) for i, (t, _) in enumerate(chapters, 1)))
    copy(out, "s_lemmas", "lemma text, pos text, accent text, gloss text",
         ((*k, *v) for k, v in sorted(lemmas.items())))
    copy(out, "s_sentences", "id int, chapter int, text text, pattern text", sentences)
    copy(out, "s_tokens", "sentence_id int, pos int, start int, form text, accent text, "
         "lemma text, lpos text, tags text, alts text", token_rows)
    copy(out, "s_phrases", "key text, kind text, meaning text",
         ((k, *v) for k, v in sorted(phrases.items())))
    copy(out, "s_hits", "key text, sentence_id int, first_pos int, last_pos int", sorted(set(hits)))
    out.write("""
INSERT INTO uk_books SELECT * FROM s_books
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;
INSERT INTO uk_chapters SELECT * FROM s_chapters
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;
INSERT INTO uk_lemmas (lemma, pos, accent, gloss) SELECT * FROM s_lemmas
    ON CONFLICT (lemma, pos) DO UPDATE SET accent = EXCLUDED.accent, gloss = EXCLUDED.gloss
    WHERE uk_lemmas.gloss = '';
INSERT INTO uk_sentences (id, chapter, text, pattern) SELECT * FROM s_sentences
    ON CONFLICT (id) DO UPDATE SET chapter = EXCLUDED.chapter, text = EXCLUDED.text,
        pattern = EXCLUDED.pattern,
        english = CASE WHEN uk_sentences.text = EXCLUDED.text THEN uk_sentences.english ELSE '' END,
        literal = CASE WHEN uk_sentences.text = EXCLUDED.text THEN uk_sentences.literal ELSE '' END,
        note = CASE WHEN uk_sentences.text = EXCLUDED.text THEN uk_sentences.note ELSE '' END;
DELETE FROM uk_sentences WHERE id > (SELECT max(id) FROM s_sentences) AND id < :top;
DELETE FROM uk_chapters WHERE id > (SELECT max(id) FROM s_chapters) AND book_id = :book;
DELETE FROM uk_phrase_hits WHERE sentence_id BETWEEN :base AND :top;
DELETE FROM uk_tokens WHERE sentence_id BETWEEN :base AND :top;
INSERT INTO uk_tokens (sentence_id, pos, start, form, accent, lemma_id, tags, alts)
    SELECT t.sentence_id, t.pos, t.start, t.form, t.accent, l.id, t.tags,
           ARRAY(SELECT a.id FROM uk_lemmas a
                 WHERE a.lemma || '/' || a.pos = ANY (string_to_array(t.alts, ';')))
    FROM s_tokens t JOIN uk_lemmas l ON l.lemma = t.lemma AND l.pos = t.lpos;
INSERT INTO uk_phrases (key, kind, meaning) SELECT * FROM s_phrases
    ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, meaning = EXCLUDED.meaning
    WHERE uk_phrases.meaning = '';
INSERT INTO uk_phrase_hits (phrase_id, sentence_id, first_pos, last_pos)
    SELECT p.id, h.sentence_id, h.first_pos, h.last_pos
    FROM s_hits h JOIN uk_phrases p ON p.key = h.key
    ON CONFLICT DO NOTHING;
COMMIT;
""".replace(":base", str(base)).replace(":top", str(base + BOOK_SPAN)).replace(":book", str(args.book)))
    return book, lemmas, phrases, hits


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("book", type=int, help="book id, 1 or more")
    parser.add_argument("title")
    parser.add_argument("epub")
    parser.add_argument("vesum")
    parser.add_argument("kaikki")
    parser.add_argument("--heading", default=r"^(частина|розділ|глава)(\s+[^\s.!?…]+){1,3}$",
                        help="pattern of a paragraph that opens a part or chapter")
    parser.add_argument("--end", default="Примітки", help="paragraph where the book text stops")
    main(parser.parse_args())
