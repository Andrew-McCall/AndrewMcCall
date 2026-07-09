// Countries trivia. Fetches the full `/api/countries` listing once, then runs
// entirely client-side: each question type samples a subject (a country or
// one of its cities) plus distinct distractors drawn from the same fetched
// pool, so no further network calls happen once the page has loaded.

type City = {
  name: string;
  x: number;
  y: number;
  population: number | null;
  capital: boolean;
};

type Country = {
  country: string;
  population: number | null;
  gdp: number | null;
  image: string;
  flag: string | null;
  cities: City[];
};

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

const formatGdp = (gdpMillions: number) => `$${Math.round(gdpMillions / 1000).toLocaleString()} billion`;
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
      return { prompt: "Which country is this?", image: subject.image, subject: null, choices, correctIndex };
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

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Countries Quiz
    </h1>
  </a>

  <div class="w-full max-w-xl mt-8 flex flex-col gap-4">
    <div id="cq-status" class="text-center text-green-800 italic">Loading countries…</div>

    <div id="cq-game" class="hidden flex-col gap-4">
      <div class="flex justify-between text-sm font-mono text-green-800">
        <div>Score: <span id="cq-score" class="text-green-400">0</span> / <span id="cq-total" class="text-green-400">0</span></div>
        <div>Best streak: <span id="cq-best" class="text-green-400">${readBestStreak()}</span></div>
      </div>

      <div id="cq-prompt" class="text-center text-lg text-green-300"></div>

      <div id="cq-image-wrap" class="hidden justify-center">
        <div class="bg-stone-100 rounded-lg p-4 max-w-xs">
          <img id="cq-image" class="max-h-48 max-w-full" />
        </div>
      </div>

      <div id="cq-choices" class="grid grid-cols-1 sm:grid-cols-2 gap-2"></div>
    </div>

    <details class="text-green-700 text-sm">
      <summary class="cursor-pointer hover:text-green-500 select-none">Settings</summary>
      <div class="mt-3 flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <label for="cq-choice-count">Choices per question:</label>
          <input id="cq-choice-count" type="number" min="2" max="6"
            class="w-16 bg-stone-900 border border-green-900 rounded px-2 py-1 text-green-300" />
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
  const bestEl = app.querySelector<HTMLSpanElement>("#cq-best")!;
  const promptEl = app.querySelector<HTMLDivElement>("#cq-prompt")!;
  const imageWrap = app.querySelector<HTMLDivElement>("#cq-image-wrap")!;
  const imageEl = app.querySelector<HTMLImageElement>("#cq-image")!;
  const choicesEl = app.querySelector<HTMLDivElement>("#cq-choices")!;
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
    const { choices: numChoices, types } = currentSettings();
    let question: Question | null = null;
    // A handful of tries in case the randomly picked type's pool is too
    // small at very high choice counts — falls through rather than stalling.
    for (let attempt = 0; attempt < 20 && !question; attempt++) {
      const type = pickRandom(types);
      question = buildQuestion(type, countries, cities, numChoices);
    }
    if (!question) {
      promptEl.textContent = "Not enough data for the current settings — lower the choice count.";
      choicesEl.innerHTML = "";
      imageWrap.classList.add("hidden");
      return;
    }

    answered = false;
    promptEl.textContent = question.prompt;
    if (question.image) {
      imageEl.src = question.image;
      imageWrap.classList.remove("hidden");
      imageWrap.classList.add("flex");
    } else {
      imageWrap.classList.add("hidden");
      imageWrap.classList.remove("flex");
    }

    choicesEl.innerHTML = "";
    question.choices.forEach((choice, i) => {
      const btn = document.createElement("button");
      btn.textContent = choice;
      btn.className =
        "border border-green-900 hover:bg-green-900/40 text-green-300 rounded px-4 py-3 text-left cursor-pointer transition-colors";
      btn.onclick = () => {
        if (answered) return;
        answered = true;
        total++;
        totalEl.textContent = total.toString();
        const correct = i === question!.correctIndex;
        if (correct) {
          score++;
          streak++;
          scoreEl.textContent = score.toString();
          btn.className =
            "border border-green-500 bg-green-900/60 text-green-300 rounded px-4 py-3 text-left cursor-pointer transition-colors";
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
          btn.className =
            "border border-red-500 bg-red-900/60 text-red-300 rounded px-4 py-3 text-left cursor-pointer transition-colors";
          const correctBtn = choicesEl.children[question!.correctIndex] as HTMLButtonElement;
          correctBtn.className =
            "border border-green-500 bg-green-900/60 text-green-300 rounded px-4 py-3 text-left cursor-pointer transition-colors";
        }
        Array.from(choicesEl.children).forEach((el) => ((el as HTMLButtonElement).disabled = true));
        setTimeout(nextQuestion, 1100);
      };
      choicesEl.appendChild(btn);
    });
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
      cities = countries.flatMap((c) =>
        c.cities.map((city) => ({ name: city.name, country: c.country, population: city.population })),
      );
      statusEl.classList.add("hidden");
      gameEl.classList.remove("hidden");
      gameEl.classList.add("flex");
      nextQuestion();
    } catch {
      statusEl.textContent = "Network error — is the API up?";
    }
  };

  init();
};
