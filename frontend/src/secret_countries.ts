// Countries trivia. Fetches the full `/api/countries` listing once, then runs
// entirely client-side: each question type samples a subject (a country or
// one of its cities) plus distinct distractors drawn from the same fetched
// pool, so no further network calls happen once the page has loaded.
//
// Registers a window `keydown` listener (1–6 answer, Enter moves on), so it
// exports `disposeCountries` for the router to call on navigation away.

import { PAGE_CLASS, pageTitle } from "./helpers";

import type { Country } from "@andrewmccall/api-types";

type FlatCity = { name: string; country: string; population: number | null };

type QuestionType =
  | "shape"
  | "flag"
  | "capital"
  | "gdp"
  | "city-country"
  | "city-population";

type Question = {
  prompt: string;
  image: string | null;
  // Map outlines are a pale grey fill, so the UI uses them as a mask over the
  // theme colour; flags must keep their real colours.
  imageIsMap?: boolean;
  subject: string | null; // the country/city name shown as text, if any
  choices: string[];
  correctIndex: number;
};

const TYPE_LABELS: Record<QuestionType, string> = {
  shape: "Country shape",
  flag: "Flag",
  capital: "Capital",
  gdp: "GDP",
  "city-country": "Country by city",
  "city-population": "City population",
};

const ALL_TYPES = Object.keys(TYPE_LABELS) as QuestionType[];

// Choice-button styles: unanswered, then the revealed correct/wrong states
// (disabled after answering, so no hover/cursor affordance). Kept here so the
// answered states stay in sync across every button.
const CHOICE_LAYOUT = "flex items-center gap-3 border px-4 py-3 text-left transition-colors";
const CHOICE_BASE = `${CHOICE_LAYOUT} border-green-900 hover:bg-green-900/40 text-green-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950`;
const CHOICE_CORRECT = `${CHOICE_LAYOUT} border-green-500 bg-green-900/60 text-green-300`;
const CHOICE_WRONG = `${CHOICE_LAYOUT} border-red-500 bg-red-900/60 text-red-300`;
const FEEDBACK_BASE = "font-mono text-sm";

type Settings = { choices: number; types: QuestionType[] };

const SETTINGS_KEY = "countries-quiz-settings";
const STREAK_KEY = "countries-quiz-best-streak";

const readSettings = (): Settings => {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (
      raw &&
      typeof raw.choices === "number" &&
      Array.isArray(raw.types) &&
      raw.types.length > 0
    ) {
      return {
        choices: Math.min(6, Math.max(2, raw.choices)),
        types: raw.types.filter((t: string) => ALL_TYPES.includes(t as QuestionType)),
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { choices: 4, types: [...ALL_TYPES] };
};

const writeSettings = (s: Settings) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* localStorage unavailable — settings just won't persist */
  }
};

const readBestStreak = (): number => {
  try {
    return parseInt(localStorage.getItem(STREAK_KEY) || "0") || 0;
  } catch {
    return 0;
  }
};

// Fisher-Yates partial shuffle: n unique picks from pool, excluding `exclude`.
function sampleDistinct<T>(pool: T[], exclude: T, n: number): T[] {
  const candidates = pool.filter((v) => v !== exclude);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, n);
}

function shuffleChoices(correct: string, distractors: string[]): { choices: string[]; correctIndex: number } {
  const choices = [correct, ...distractors];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return { choices, correctIndex: choices.indexOf(correct) };
}

const pickRandom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export const formatGdp = (gdpMillions: number) => {
  const millions = Math.round(gdpMillions);
  return millions < 1000
    ? `$${millions.toLocaleString()} million`
    : `$${Math.round(millions / 1000).toLocaleString()} billion`;
};
const formatPopulation = (pop: number) => pop.toLocaleString();

function buildQuestion(
  type: QuestionType,
  countries: Country[],
  cities: FlatCity[],
  numChoices: number,
): Question | null {
  const names = countries.map((c) => c.country);

  switch (type) {
    case "shape": {
      const subject = pickRandom(countries);
      const { choices, correctIndex } = shuffleChoices(
        subject.country,
        sampleDistinct(names, subject.country, numChoices - 1),
      );
      return { prompt: "Which country is this?", image: subject.image, imageIsMap: true, subject: null, choices, correctIndex };
    }
    case "flag": {
      const withFlag = countries.filter((c) => c.flag);
      if (withFlag.length < numChoices) return null;
      const subject = pickRandom(withFlag);
      const { choices, correctIndex } = shuffleChoices(
        subject.country,
        sampleDistinct(names, subject.country, numChoices - 1),
      );
      return { prompt: "Whose flag is this?", image: subject.flag, subject: null, choices, correctIndex };
    }
    case "capital": {
      const capitals = countries
        .map((c) => ({ country: c.country, capital: c.cities.find((city) => city.capital)?.name }))
        .filter((c): c is { country: string; capital: string } => !!c.capital);
      if (capitals.length < numChoices) return null;
      const subject = pickRandom(capitals);
      const pool = capitals.map((c) => c.capital);
      const { choices, correctIndex } = shuffleChoices(
        subject.capital,
        sampleDistinct(pool, subject.capital, numChoices - 1),
      );
      return {
        prompt: `What is the capital of ${subject.country}?`,
        image: null,
        subject: null,
        choices,
        correctIndex,
      };
    }
    case "gdp": {
      const withGdp = countries.filter((c) => c.gdp);
      if (withGdp.length < numChoices) return null;
      const subject = pickRandom(withGdp);
      const correct = formatGdp(subject.gdp!);
      const pool = Array.from(new Set(withGdp.map((c) => formatGdp(c.gdp!))));
      const { choices, correctIndex } = shuffleChoices(correct, sampleDistinct(pool, correct, numChoices - 1));
      return { prompt: `What is ${subject.country}'s GDP?`, image: null, subject: null, choices, correctIndex };
    }
    case "city-country": {
      if (cities.length < 1) return null;
      const subject = pickRandom(cities);
      const { choices, correctIndex } = shuffleChoices(
        subject.country,
        sampleDistinct(names, subject.country, numChoices - 1),
      );
      return {
        prompt: `Which country is ${subject.name} in?`,
        image: null,
        subject: null,
        choices,
        correctIndex,
      };
    }
    case "city-population": {
      const withPop = cities.filter((c) => c.population);
      if (withPop.length < numChoices) return null;
      const subject = pickRandom(withPop);
      const correct = formatPopulation(subject.population!);
      const pool = Array.from(new Set(withPop.map((c) => formatPopulation(c.population!))));
      const { choices, correctIndex } = shuffleChoices(correct, sampleDistinct(pool, correct, numChoices - 1));
      return {
        prompt: `What is the population of ${subject.name}?`,
        image: null,
        subject: null,
        choices,
        correctIndex,
      };
    }
  }
}

// Module-scoped so the router can detach the listener and pending advance.
let dispose: (() => void) | null = null;

export function disposeCountries(): void {
  dispose?.();
  dispose = null;
}

export default (app: HTMLElement) => {
  disposeCountries(); // drop anything left from a previous visit

  app.innerHTML = `
<div class="${PAGE_CLASS}">
  ${pageTitle("Countries Quiz")}

  <div class="w-full max-w-xl mt-8 flex flex-col gap-4">
    <div id="cq-status" class="text-center text-green-800 italic">Loading countries…</div>

    <div id="cq-game" class="hidden flex-col gap-4">
      <div class="flex justify-between text-sm font-mono text-green-800">
        <div>Score: <span id="cq-score" class="text-green-400">0</span> / <span id="cq-total" class="text-green-400">0</span></div>
        <div>Streak: <span id="cq-streak" class="text-green-400">0</span> · Best: <span id="cq-best" class="text-green-400">${readBestStreak()}</span></div>
      </div>

      <div class="text-center">
        <div id="cq-type" class="text-xs uppercase tracking-widest text-green-800"></div>
        <div id="cq-prompt" class="mt-1 text-lg text-green-300"></div>
      </div>

      <div id="cq-stage" hidden class="flex h-48 sm:h-64 items-center justify-center">
        <div id="cq-map" role="img" hidden class="h-full w-full bg-green-500"></div>
        <img id="cq-flag" hidden class="max-h-full max-w-full border border-green-900" />
      </div>

      <div id="cq-choices" class="grid grid-cols-1 sm:grid-cols-2 gap-2"></div>

      <!-- Fixed height so the layout doesn't jump when feedback appears. -->
      <div class="h-10 flex items-center justify-center gap-4">
        <div id="cq-feedback" class="${FEEDBACK_BASE}"></div>
        <button id="cq-next" hidden class="border border-green-700 hover:bg-green-900/40 text-green-300 px-3 py-1 font-mono text-sm cursor-pointer">Next ↵</button>
      </div>
      <div class="hidden sm:block text-center text-xs font-mono text-green-900">Keys 1–6 answer · Enter for next</div>
    </div>

    <details class="text-green-700 text-sm">
      <summary class="cursor-pointer hover:text-green-500 select-none">Settings</summary>
      <div class="mt-3 flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <label for="cq-choice-count">Choices per question:</label>
          <input id="cq-choice-count" type="number" min="2" max="6"
            class="w-16 bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-2 py-1 text-green-300" />
        </div>
        <div id="cq-types" class="flex flex-col gap-1"></div>
      </div>
    </details>
  </div>
</div>`;

  const statusEl = app.querySelector<HTMLDivElement>("#cq-status")!;
  const gameEl = app.querySelector<HTMLDivElement>("#cq-game")!;
  const scoreEl = app.querySelector<HTMLSpanElement>("#cq-score")!;
  const totalEl = app.querySelector<HTMLSpanElement>("#cq-total")!;
  const streakEl = app.querySelector<HTMLSpanElement>("#cq-streak")!;
  const bestEl = app.querySelector<HTMLSpanElement>("#cq-best")!;
  const typeEl = app.querySelector<HTMLDivElement>("#cq-type")!;
  const promptEl = app.querySelector<HTMLDivElement>("#cq-prompt")!;
  const stageEl = app.querySelector<HTMLDivElement>("#cq-stage")!;
  const mapEl = app.querySelector<HTMLDivElement>("#cq-map")!;
  const flagEl = app.querySelector<HTMLImageElement>("#cq-flag")!;
  const choicesEl = app.querySelector<HTMLDivElement>("#cq-choices")!;
  const feedbackEl = app.querySelector<HTMLDivElement>("#cq-feedback")!;
  const nextBtn = app.querySelector<HTMLButtonElement>("#cq-next")!;
  const choiceCountInput = app.querySelector<HTMLInputElement>("#cq-choice-count")!;
  const typesEl = app.querySelector<HTMLDivElement>("#cq-types")!;

  const settings = readSettings();
  choiceCountInput.value = settings.choices.toString();

  for (const type of ALL_TYPES) {
    const row = document.createElement("label");
    row.className = "flex items-center gap-2 cursor-pointer";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = settings.types.includes(type);
    checkbox.dataset.type = type;
    row.appendChild(checkbox);
    row.appendChild(document.createTextNode(TYPE_LABELS[type]));
    typesEl.appendChild(row);
  }

  let score = 0;
  let total = 0;
  let bestStreak = readBestStreak();
  let streak = 0;
  let answered = false;
  let advance: number | undefined;
  let countries: Country[] = [];
  let cities: FlatCity[] = [];

  const currentSettings = (): Settings => {
    const checked = Array.from(
      typesEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked"),
    ).map((el) => el.dataset.type as QuestionType);
    const choices = Math.min(6, Math.max(2, parseInt(choiceCountInput.value) || 4));
    return { choices, types: checked.length > 0 ? checked : settings.types };
  };

  const nextQuestion = () => {
    clearTimeout(advance);
    nextBtn.hidden = true;
    answered = false;
    feedbackEl.textContent = "";
    feedbackEl.className = FEEDBACK_BASE;
    const { choices: numChoices, types } = currentSettings();
    let question: Question | null = null;
    let type: QuestionType = types[0];
    // A handful of tries in case the randomly picked type's pool is too
    // small at very high choice counts — falls through rather than stalling.
    for (let attempt = 0; attempt < 20 && !question; attempt++) {
      type = pickRandom(types);
      question = buildQuestion(type, countries, cities, numChoices);
    }
    if (!question) {
      typeEl.textContent = "";
      promptEl.textContent = "Not enough data for the current settings — lower the choice count.";
      choicesEl.innerHTML = "";
      stageEl.hidden = true;
      return;
    }

    typeEl.textContent = TYPE_LABELS[type];
    promptEl.textContent = question.prompt;
    // Generic, non-spoiling labels — anything more specific would give the
    // answer away to screen reader users before they can guess.
    if (question.image && question.imageIsMap) {
      const mask = `url("${question.image}") center / contain no-repeat`;
      mapEl.style.mask = mask;
      mapEl.style.setProperty("-webkit-mask", mask);
      mapEl.ariaLabel = "Country outline to identify";
    } else if (question.image) {
      flagEl.src = question.image;
      flagEl.alt = "Flag to identify";
    }
    stageEl.hidden = !question.image;
    mapEl.hidden = !question.imageIsMap;
    flagEl.hidden = !question.image || !!question.imageIsMap;

    choicesEl.innerHTML = "";
    question.choices.forEach((choice, i) => {
      const btn = document.createElement("button");
      const key = document.createElement("kbd");
      key.className = "text-xs text-green-700";
      key.textContent = String(i + 1);
      const label = document.createElement("span");
      label.textContent = choice;
      btn.append(key, label);
      btn.className = CHOICE_BASE;
      btn.onclick = () => {
        if (answered) return;
        answered = true;
        total++;
        totalEl.textContent = total.toString();

        const correct = i === question!.correctIndex;
        const correctBtn = choicesEl.children[question!.correctIndex] as HTMLButtonElement;
        const answerText = question!.choices[question!.correctIndex];

        // Always reveal the right answer in green; on a wrong pick, also mark
        // the chosen button red. The correct answer stays visible either way.
        correctBtn.className = CHOICE_CORRECT;
        if (correct) {
          score++;
          streak++;
          scoreEl.textContent = score.toString();
          streakEl.textContent = streak.toString();
          feedbackEl.textContent = streak >= 3 ? `🔥 Correct — ${streak} in a row!` : "Correct!";
          feedbackEl.className = `${FEEDBACK_BASE} text-green-400`;
          if (streak > bestStreak) {
            bestStreak = streak;
            bestEl.textContent = bestStreak.toString();
            try {
              localStorage.setItem(STREAK_KEY, bestStreak.toString());
            } catch {
              /* no persistence available */
            }
          }
        } else {
          streak = 0;
          streakEl.textContent = "0";
          btn.className = CHOICE_WRONG;
          feedbackEl.textContent = `Answer: ${answerText}`;
          feedbackEl.className = `${FEEDBACK_BASE} text-red-400`;
        }

        // Lock the round and fade the choices that were neither picked nor
        // correct, so the eye lands on the pick and the answer.
        Array.from(choicesEl.children).forEach((el) => {
          const b = el as HTMLButtonElement;
          b.disabled = true;
          if (b !== btn && b !== correctBtn) b.classList.add("opacity-40");
        });

        // Keep the pace up when correct; on a miss, wait for Next so the
        // revealed answer can be read.
        if (correct) {
          advance = window.setTimeout(nextQuestion, 900);
        } else {
          nextBtn.hidden = false;
          nextBtn.focus();
        }
      };
      choicesEl.appendChild(btn);
    });
  };

  nextBtn.onclick = nextQuestion;

  const onKey = (e: KeyboardEvent) => {
    if (gameEl.classList.contains("hidden") || e.ctrlKey || e.metaKey || e.altKey) return;
    // Leave keys alone while focus is on anything but the page or the quiz,
    // so links, settings and the choice-count field keep working.
    if (e.target !== document.body && !choicesEl.contains(e.target as Node) && e.target !== nextBtn) return;
    if (e.key === "Enter" && answered) {
      e.preventDefault(); // stop a focused Next button also firing its click
      nextQuestion();
      return;
    }
    const pick = choicesEl.children[parseInt(e.key) - 1] as HTMLButtonElement | undefined;
    if (!answered && pick) pick.click();
  };
  window.addEventListener("keydown", onKey);
  dispose = () => {
    window.removeEventListener("keydown", onKey);
    clearTimeout(advance);
  };

  choiceCountInput.addEventListener("change", () => {
    writeSettings(currentSettings());
    if (!gameEl.classList.contains("hidden")) nextQuestion();
  });

  typesEl.addEventListener("change", (e) => {
    const boxes = Array.from(typesEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    const checked = boxes.filter((b) => b.checked);
    if (checked.length === 0) {
      // At least one type must stay active — undo the click that would empty it.
      (e.target as HTMLInputElement).checked = true;
      return;
    }
    writeSettings(currentSettings());
    if (!gameEl.classList.contains("hidden")) nextQuestion();
  });

  const init = async () => {
    try {
      const res = await fetch("/api/countries");
      if (!res.ok) throw new Error(`status ${res.status}`);
      countries = await res.json();
      if (countries.length === 0) throw new Error("no countries");
      cities = countries.flatMap((c) =>
        c.cities.map((city) => ({ name: city.name, country: c.country, population: city.population })),
      );
      statusEl.classList.add("hidden");
      gameEl.classList.remove("hidden");
      gameEl.classList.add("flex");
      nextQuestion();
    } catch {
      statusEl.textContent = "Couldn't load the countries — try again later.";
    }
  };

  init();
};
