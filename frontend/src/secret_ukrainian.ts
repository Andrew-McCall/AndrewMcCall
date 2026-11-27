// The Ukrainian reader. You type the next sentence of a paper book, a word at
// a time, on the Ukrainian keyboard layout. Each finished word shows what it
// is and where you met it before; each finished sentence shows its lesson.
// Everything shown is stored data: nothing here calls a model.

import type { UkCard, UkExample, UkPhrase, UkState, UkWord } from "@andrewmccall/api-types";
import { api, errorText, esc, jsonInit, PAGE_CLASS, pageTitle } from "./helpers";
import { caseUses, partName, readings } from "./ukrainian/grammar";
import { canType, charFor, FINGERS, keyFor, ROWS } from "./ukrainian/keyboard";
import { sound, SOUND_KEY } from "./ukrainian/sound";
import { accept, blank, norm, weave } from "./ukrainian/typing";

const BOX = "w-full bg-stone-950/40 border border-green-900/40 p-4 text-left";
const BUTTON =
  "bg-stone-900 border border-green-900 px-3 py-1 text-lime-400 hover:border-green-500 " +
  "hover:text-lime-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500";
const INPUT =
  "w-full bg-stone-900 border border-green-800 px-3 py-2 text-2xl text-lime-200 " +
  "focus:outline-none focus:border-green-400";
const LABEL = "text-xs uppercase tracking-widest text-green-700";
const FINGER_TINT = [
  "bg-rose-950/70", "bg-amber-950/70", "bg-emerald-950/70", "bg-sky-950/70",
  "bg-sky-950/70", "bg-emerald-950/70", "bg-amber-950/70", "bg-rose-950/70",
];
const ROW_INDENT = ["", "ml-[4.5%]", "ml-[6%]", "ml-[3%]"];

const call = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await api(path, body === undefined ? undefined : jsonInit(body));
  if (!res.ok) throw new Error(await errorText(res));
  return res.status === 204 ? (undefined as T) : res.json();
};

const speak = (text: string) => {
  const say = new SpeechSynthesisUtterance(text);
  say.lang = "uk-UA";
  speechSynthesis.cancel();
  speechSynthesis.speak(say);
};

const canSpeak = (): boolean =>
  "speechSynthesis" in window &&
  speechSynthesis.getVoices().some((voice) => voice.lang.toLowerCase().startsWith("uk"));

const speakButton = (text: string): string =>
  canSpeak()
    ? `<button data-say="${esc(text)}" class="${BUTTON}" title="Hear it">&#9658;</button>`
    : "";

// Types Ukrainian from the physical keys, whatever layout the system is in.
// `onValue` gets the whole field after every change; `enter` is true for Enter.
const typeUkrainian = (
  input: HTMLInputElement,
  onValue: (value: string, enter: boolean) => void,
) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      return onValue(input.value, true);
    }
    const typedByLayout = event.key.length !== 1 || /[Ѐ-ӿ]/.test(event.key);
    if (event.ctrlKey || event.metaKey || event.altKey || typedByLayout) return;
    const char = charFor(event.code);
    if (!char) return;
    event.preventDefault();
    input.setRangeText(char, input.selectionStart ?? 0, input.selectionEnd ?? 0, "end");
    onValue(input.value, false);
  });
  input.addEventListener("input", () => onValue(input.value, false));
};

const keyboard = (lit?: string): string => {
  const hint = lit === " " ? undefined : lit && keyFor(lit);
  const rows = ROWS.map(
    (row, i) =>
      `<div class="flex gap-1 ${ROW_INDENT[i]}">${row
        .map((key) => {
          const on = key === hint;
          const home = key.en === "f" || key.en === "j" ? " border-b-lime-400" : "";
          const look = on ? "bg-lime-400 text-stone-950 border-lime-200" : `${FINGER_TINT[key.finger]} border-green-900${home}`;
          return `<div class="w-[7%] border ${look} px-1 py-0.5 text-center leading-tight">
            <div class="text-lg">${esc(key.uk)}</div>
            <div class="text-[10px] opacity-50">${esc(key.en)}</div>
          </div>`;
        })
        .join("")}</div>`,
  ).join("");
  const space = `<div class="flex"><div class="ml-[25%] w-[45%] border ${
    lit === " " ? "bg-lime-400 text-stone-950 border-lime-200" : "border-green-900"
  } text-center text-[10px] py-1">space</div></div>`;
  const which = lit === " " ? "Press space to finish the word." : hint ? `${esc(hint.uk)}: ${FINGERS[hint.finger]}` : "&nbsp;";
  return `<div class="flex flex-col gap-1 select-none">${rows}${space}</div>
    <p class="text-sm text-lime-300 mt-1 h-5">${which}</p>`;
};

const examples = (list: UkExample[]): string =>
  list
    .map(
      (example) =>
        `<li class="mt-1"><span class="text-lime-200">${esc(example.text)}</span>${
          example.english ? `<br><span class="text-green-600">${esc(example.english)}</span>` : ""
        }</li>`,
    )
    .join("");

// One labelled line of the word card.
const row = (label: string, body: string): string =>
  body ? `<div class="mt-2"><span class="${LABEL}">${label}</span><div>${body}</div></div>` : "";

const times = (count: number): string => `${count} time${count === 1 ? "" : "s"}`;

const wordCard = (word: UkWord): string => {
  const shown = word.accent || word.form;
  const base = word.lemma_accent || word.lemma;
  const senses = word.gloss.split(";").map((sense) => sense.trim()).filter(Boolean);
  const forms = readings(word.tags);
  const uses = caseUses(word.tags)
    .map(([name, use]) => `<li><span class="text-lime-300">${name}</span>: ${use}</li>`)
    .join("");
  const stress = word.accent ? "" : ' <span class="text-green-700">(stress not known)</span>';
  return `<div class="${BOX}">
    <div class="flex items-baseline gap-3 flex-wrap">
      <span class="text-3xl text-lime-200">${esc(shown)}</span>
      ${speakButton(word.form)}
    </div>
    ${row("Say it", `<span class="text-xl text-lime-300" title="${esc(SOUND_KEY)}">${esc(sound(shown))}</span>${stress}`)}
    ${row(
      "Meaning",
      senses.length
        ? `<ul class="text-xl">${senses.map((sense) => `<li>${esc(sense)}</li>`).join("")}</ul>`
        : '<span class="text-green-800">no dictionary entry yet</span>',
    )}
    ${row("Word", `${esc(partName(word.part))}${base === shown ? "" : `, a form of <span class="text-lime-300">${esc(base)}</span> (${esc(sound(base))})`}`)}
    ${row("Form here", forms.length ? `${forms.map(esc).join('<br><span class="text-green-700">or</span> ')}${uses ? `<ul class="text-sm text-green-600">${uses}</ul>` : ""}` : "")}
    ${row("Same spelling, other word", word.alts.map(esc).join("<br>"))}
    ${row(
      "In this book",
      `${word.seen ? `You met this word ${times(word.seen)} before.` : "This is a new word."} It comes ${times(word.ahead)} more.${
        word.examples.length ? `<ul class="text-sm">${examples(word.examples)}</ul>` : ""
      }`,
    )}
  </div>`;
};

const PHRASE_KIND: Record<string, string> = {
  idiom: "Fixed phrase",
  grammar: "Grammar",
  pair: "These words often come together",
};

const phraseCard = (phrase: UkPhrase): string =>
  `<div class="${BOX}">
    <p class="${LABEL}">${PHRASE_KIND[phrase.kind] ?? esc(phrase.kind)}</p>
    <p><span class="text-xl text-lime-200">${esc(phrase.key)}</span>${phrase.meaning ? ` &mdash; ${esc(phrase.meaning)}` : ""}</p>
    <p class="text-sm">${phrase.seen ? `Met ${phrase.seen} time${phrase.seen === 1 ? "" : "s"} before.` : "First time."}</p>
    ${phrase.examples.length ? `<ul class="text-sm">${examples(phrase.examples)}</ul>` : ""}
  </div>`;

const secretUkrainian = async (app: HTMLElement) => {
  app.innerHTML = `<div class="${PAGE_CLASS}">
    ${pageTitle("Ukrainian")}
    <p id="uk-error" class="w-full max-w-3xl text-red-400 mt-6"></p>
    <div id="uk" class="w-full max-w-3xl flex flex-col gap-4"></div>
  </div>`;
  const root = app.querySelector<HTMLDivElement>("#uk")!;
  const error = app.querySelector<HTMLElement>("#uk-error")!;
  const slot = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;

  // Chrome loads its voices late; asking now has them ready for the first card.
  if ("speechSynthesis" in window) speechSynthesis.getVoices();

  let state: UkState;
  let at = 0; // the word being typed
  let typed = "";
  let hint = false;
  let open: number | null = null; // the word whose card is shown
  const missed = new Set<number>();
  const keys = { right: 0, wrong: 0 };

  // The view stays as it is, so the action can be tried again.
  const fail = (err: unknown) => {
    error.textContent = `${err instanceof Error ? err.message : err}. Try again.`;
  };

  // A word the layout cannot type (Russian, Latin) is shown, not asked for.
  const passUntypable = () => {
    const words = state.sentence?.words ?? [];
    while (at < words.length && !canType(words[at].form)) at += 1;
  };

  const show = (next: UkState) => {
    error.textContent = "";
    state = next;
    at = 0;
    typed = "";
    hint = false;
    open = null;
    missed.clear();
    passUntypable();
    reader();
  };

  const header = (): string => {
    const sentence = state.sentence;
    const place = sentence ? (sentence.id % 1_000_000) - 1 : state.total;
    const books =
      state.books.length > 1
        ? `<select id="uk-book" class="${BUTTON}">${state.books
            .map((book) => `<option value="${book.id}"${book.id === state.book ? " selected" : ""}>${esc(book.title)}</option>`)
            .join("")}</select>`
        : `<span class="text-lime-300">${esc(state.books[0]?.title ?? "")}</span>`;
    // The shown entry is a label, so picking the current chapter restarts it.
    const here = state.chapters.find((chapter) => chapter.id === sentence?.chapter);
    const chapters = `<select id="uk-chapter" class="${BUTTON} max-w-full">
      <option selected disabled>${esc(here?.title ?? "Go to a chapter")}</option>${state.chapters
        .map((chapter) => `<option value="${chapter.id}">${esc(chapter.title)}</option>`)
        .join("")}</select>`;
    return `<div class="flex flex-wrap items-center gap-3 justify-between">
      ${books}${chapters}
      <span class="text-sm">${place} of ${state.total} sentences</span>
      <button id="uk-review" class="${BUTTON}"${state.due ? "" : " disabled"}>Review${state.due ? ` (${state.due} due)` : ""}</button>
    </div>`;
  };

  const bindHeader = () => {
    const go = (body: unknown) => call<UkState>("/uk/goto", body).then(show, fail);
    // A jump replaces the saved place, so one slip of a key must not do it.
    slot("uk-chapter").addEventListener("change", (event) => {
      const select = event.target as HTMLSelectElement;
      const title = select.selectedOptions[0].text;
      if (confirm(`Move your place in this book to the start of "${title}"?`)) {
        go({ chapter: Number(select.value) });
      } else {
        select.selectedIndex = 0;
      }
    });
    root.querySelector("#uk-book")?.addEventListener("change", (event) =>
      go({ book: Number((event.target as HTMLSelectElement).value) }),
    );
    slot("uk-review").addEventListener("click", () => review());
  };

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-say],[data-word]");
    if (target?.dataset.say) speak(target.dataset.say);
    if (target?.dataset.word) {
      open = Number(target.dataset.word);
      paint();
    }
  });

  // Redraws everything that changes while typing; the input itself stays put.
  const paint = () => {
    const sentence = state.sentence!;
    const words = sentence.words;
    slot("uk-text").innerHTML = weave(
      sentence.text,
      words,
      (i) =>
        i < at
          ? `<button data-word="${i}" class="hover:text-lime-200 ${missed.has(i) ? "text-amber-400" : "text-lime-400"}">${esc(words[i].form)}</button>`
          : `<span class="tracking-[0.15em] ${i === at ? "text-lime-200" : "text-green-900"}">${esc(blank(words[i].form, i === at ? typed : ""))}</span>`,
      esc,
    );
    const word = words[at];
    const next = word ? (typed.length < word.form.length ? word.form[typed.length] : " ") : undefined;
    slot("uk-keys").innerHTML = keyboard(hint ? next : undefined);
    const total = keys.right + keys.wrong;
    slot("uk-score").textContent = total
      ? `Keys: ${keys.right} right, ${keys.wrong} wrong (${Math.round((100 * keys.right) / total)}%)`
      : "";
    const done = at === words.length;
    const cards = sentence.phrases
      .filter((phrase) => (done ? true : open !== null && phrase.last === open))
      .map(phraseCard)
      .join("");
    slot("uk-card").innerHTML = (open === null ? "" : wordCard(words[open])) + (done ? "" : cards);
    slot("uk-lesson").innerHTML = done ? lesson(cards) : "";
    if (done) slot("uk-next").focus();
  };

  const lesson = (phrases: string): string => {
    const sentence = state.sentence!;
    const rough = sentence.words.map((word) => word.gloss.split(/[;,(]/)[0].trim() || word.form).join(" · ");
    const similar = sentence.similar.length
      ? `<div class="${BOX}"><p class="${LABEL}">Same sentence shape as</p><ul class="text-sm">${examples(sentence.similar)}</ul></div>`
      : "";
    return `<div class="${BOX} border-lime-700">
      <p class="${LABEL}">Meaning ${speakButton(sentence.text)}</p>
      <p class="text-xl text-lime-200">${sentence.english ? esc(sentence.english) : '<span class="text-green-700">No lesson is written for this sentence yet. Word by word:</span>'}</p>
      <p class="mt-2"><span class="${LABEL}">Word by word</span><br>${esc(sentence.literal || rough)}</p>
      ${sentence.note ? `<p class="mt-2"><span class="${LABEL}">Note</span><br>${esc(sentence.note)}</p>` : ""}
    </div>
    ${phrases}${similar}
    <button id="uk-next" class="${BUTTON} self-end">Next sentence (Enter)</button>`;
  };

  const finishWord = () => {
    open = at;
    at += 1;
    typed = "";
    hint = false;
    passUntypable();
  };

  const reader = () => {
    const sentence = state.sentence;
    if (!sentence) {
      root.innerHTML = state.books.length
        ? `${header()}<p class="text-xl text-lime-200">You have reached the end of this book.</p>`
        : `<p>No book is loaded yet.</p>`;
      if (state.books.length) bindHeader();
      return;
    }
    root.innerHTML = `${header()}
      <p id="uk-text" class="text-2xl leading-relaxed font-mono break-words"></p>
      <div class="flex flex-wrap sm:flex-nowrap gap-2 items-center">
        <input id="uk-input" class="${INPUT}" lang="uk" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="type the next word, then space">
        <button id="uk-show" class="${BUTTON} whitespace-nowrap" title="Show this word and review it sooner">Show word</button>
        <button id="uk-skip" class="${BUTTON} whitespace-nowrap" title="Show the whole sentence">Skip</button>
      </div>
      <div id="uk-keys"></div>
      <p id="uk-score" class="text-xs text-green-700"></p>
      <p class="text-xs text-green-700">Say it: ${esc(SOUND_KEY)}</p>
      <div id="uk-card" class="flex flex-col gap-4"></div>
      <div id="uk-lesson" class="flex flex-col gap-4"></div>`;
    bindHeader();
    const input = slot("uk-input") as HTMLInputElement;
    const words = sentence.words;

    typeUkrainian(input, (value, enter) => {
      const word = words[at];
      if (!word) return;
      const commit = enter || /\s$/.test(value);
      if (commit && !value.trim()) {
        input.value = "";
        return;
      }
      const result = accept(word.form, value.trim());
      keys.right += Math.max(0, result.typed.length - typed.length);
      typed = result.typed;
      if (result.done && !result.wrong && commit) finishWord();
      else if (result.wrong || commit) {
        keys.wrong += 1;
        hint = true;
      }
      input.value = typed;
      paint();
    });
    slot("uk-show").addEventListener("click", () => {
      if (at < words.length) {
        missed.add(at);
        finishWord();
        input.value = "";
        paint();
      }
      if (at < words.length) input.focus();
    });
    // Skipped words were not typed, so they come up for review first.
    slot("uk-skip").addEventListener("click", () => {
      for (let i = at; i < words.length; i++) missed.add(i);
      at = words.length;
      typed = "";
      input.value = "";
      paint();
    });
    slot("uk-lesson").addEventListener("click", (event) => {
      if ((event.target as HTMLElement).id === "uk-next") {
        call<UkState>("/uk/done", { sentence_id: sentence.id, missed: [...missed] }).then(show, fail);
      }
    });
    paint();
    input.focus();
  };

  // Each due word comes back inside a sentence you have typed, with a gap to fill.
  const review = async () => {
    const cards = await call<UkCard[]>("/uk/review").catch(fail);
    if (!cards) return;
    let right = 0;
    const card = (i: number) => {
      const current = cards[i];
      if (!current) {
        root.innerHTML = `<p class="text-xl text-lime-200">Review done: ${right} of ${cards.length} right.</p>
          <button id="uk-back" class="${BUTTON} self-start">Back to the book</button>`;
        slot("uk-back").addEventListener("click", () => call<UkState>("/uk").then(show, fail));
        slot("uk-back").focus();
        return;
      }
      root.innerHTML = `<p class="${LABEL}">Review ${i + 1} of ${cards.length}</p>
        <p class="text-2xl leading-relaxed font-mono break-words">${weave(current.text, [current], () => `<span class="tracking-[0.15em] text-lime-200">${blank(current.form)}</span>`, esc)}</p>
        <p class="text-xl">${esc(current.gloss || current.lemma)} <span class="text-green-700">(${esc(partName(current.part))})</span></p>
        ${current.english ? `<p class="text-green-600">${esc(current.english)}</p>` : ""}
        <div class="flex gap-2 items-center">
          <input id="uk-input" class="${INPUT}" lang="uk" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="type the missing word, then Enter">
          <button id="uk-show" class="${BUTTON} whitespace-nowrap">Show</button>
        </div>
        <div id="uk-keys">${keyboard()}</div>
        <div id="uk-answer" class="flex flex-col gap-4"></div>`;
      const input = slot("uk-input") as HTMLInputElement;
      const settle = (ok: boolean) => {
        if (input.disabled) return;
        if (ok) right += 1;
        input.disabled = true;
        call("/uk/review", { lemma_id: current.lemma_id, ok }).catch(fail);
        slot("uk-answer").innerHTML = `<p class="text-2xl ${ok ? "text-lime-300" : "text-amber-400"}">${ok ? "Right" : "It is"}: ${esc(current.form)} <span class="text-lime-300">(${esc(sound(current.form))})</span> ${speakButton(current.form)}</p>
          <button id="uk-next" class="${BUTTON} self-end">Next (Enter)</button>`;
        slot("uk-next").addEventListener("click", () => card(i + 1));
        slot("uk-next").focus();
      };
      typeUkrainian(input, (value, enter) => {
        if (enter && value.trim()) settle(norm(value.trim()) === norm(current.form));
      });
      slot("uk-show").addEventListener("click", () => settle(false));
      input.focus();
    };
    card(0);
  };

  call<UkState>("/uk").then(show, fail);
};

export default secretUkrainian;
