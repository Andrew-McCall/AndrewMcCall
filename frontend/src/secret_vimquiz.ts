// Vim Quiz — a multiple-choice drill over Vim's command vocabulary. Each round
// either asks "which command does X?" (pick the keys) or "what does `cmd` do?"
// (pick the description); distractors are drawn from the same fact pool so the
// wrong answers are always other real Vim commands. Best streak persists.
//
// Mounts into a host element handed in by the Vim page (`:quiz`); `mountQuiz`
// returns a dispose fn.

interface Fact {
  cmd: string;
  desc: string;
}

// Command → plain-English effect. Kept deliberately unambiguous so a question
// has exactly one right answer among its distractors.
const FACTS: Fact[] = [
  { cmd: "dd", desc: "delete the current line" },
  { cmd: "yy", desc: "yank (copy) the current line" },
  { cmd: "p", desc: "paste after the cursor" },
  { cmd: "P", desc: "paste before the cursor" },
  { cmd: "x", desc: "delete the character under the cursor" },
  { cmd: "cw", desc: "change to the end of the word" },
  { cmd: "ciw", desc: "change the whole word under the cursor" },
  { cmd: "dw", desc: "delete to the start of the next word" },
  { cmd: "diw", desc: "delete the whole word under the cursor" },
  { cmd: "A", desc: "append at the end of the line" },
  { cmd: "I", desc: "insert at the first non-blank of the line" },
  { cmd: "o", desc: "open a new line below and insert" },
  { cmd: "O", desc: "open a new line above and insert" },
  { cmd: "u", desc: "undo the last change" },
  { cmd: "Ctrl-r", desc: "redo the last undone change" },
  { cmd: "gg", desc: "jump to the first line" },
  { cmd: "G", desc: "jump to the last line" },
  { cmd: "0", desc: "move to the first column of the line" },
  { cmd: "$", desc: "move to the end of the line" },
  { cmd: "^", desc: "move to the first non-blank of the line" },
  { cmd: "w", desc: "move forward to the start of the next word" },
  { cmd: "b", desc: "move back to the start of the previous word" },
  { cmd: "e", desc: "move to the end of the next word" },
  { cmd: "dd p", desc: "swap the current line with the one below" },
  { cmd: "r", desc: "replace a single character" },
  { cmd: "J", desc: "join the next line onto this one" },
  { cmd: "~", desc: "toggle the case of the character under the cursor" },
  { cmd: ">>", desc: "indent the current line" },
  { cmd: "<<", desc: "dedent the current line" },
  { cmd: "ci\"", desc: "change the text inside the double quotes" },
  { cmd: "de", desc: "delete to the end of the word" },
  { cmd: "D", desc: "delete from the cursor to the end of the line" },
  { cmd: "C", desc: "change from the cursor to the end of the line" },
  { cmd: "v", desc: "start characterwise visual selection" },
  { cmd: "V", desc: "start linewise visual selection" },
];

const STREAK_KEY = "vim-quiz-best-streak";

const readBest = (): number => {
  try {
    return parseInt(localStorage.getItem(STREAK_KEY) || "0") || 0;
  } catch {
    return 0;
  }
};
const writeBest = (n: number) => {
  try {
    localStorage.setItem(STREAK_KEY, String(n));
  } catch {
    /* no persistence available */
  }
};

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// n distinct facts other than `not`.
function sampleFacts(not: Fact, n: number): Fact[] {
  const pool = FACTS.filter((f) => f !== not && f.desc !== not.desc && f.cmd !== not.cmd);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

const CHOICE_BASE =
  "border border-green-900 hover:bg-green-900/40 text-green-300 rounded px-4 py-3 text-left cursor-pointer transition-colors font-mono";
const CHOICE_CORRECT =
  "border border-green-500 bg-green-900/60 text-green-300 rounded px-4 py-3 text-left transition-colors font-mono";
const CHOICE_WRONG =
  "border border-red-500 bg-red-900/60 text-red-300 rounded px-4 py-3 text-left transition-colors font-mono";

export function mountQuiz(host: HTMLElement): () => void {
  host.innerHTML = `
<div class="flex flex-col items-center w-full">
  <p class="text-green-800 font-mono text-sm text-center max-w-xl">
    Learn what each command does. Pick the right answer — a wrong pick resets
    your streak.
  </p>

  <div class="flex justify-between w-full max-w-xl mt-4 font-mono text-sm text-green-700">
    <div>Score: <span id="q-score" class="text-green-400">0</span> / <span id="q-total" class="text-green-400">0</span></div>
    <div>Streak: <span id="q-streak" class="text-green-400">0</span></div>
    <div>Best: <span id="q-best" class="text-green-400">${readBest()}</span></div>
  </div>

  <div class="w-full max-w-xl mt-4 flex flex-col gap-4">
    <div id="q-prompt" class="text-center text-lg text-green-300"></div>
    <div id="q-choices" class="grid grid-cols-1 gap-2"></div>
    <div id="q-feedback" class="h-6 text-center font-mono text-sm"></div>
  </div>
</div>`;

  const scoreEl = host.querySelector<HTMLSpanElement>("#q-score")!;
  const totalEl = host.querySelector<HTMLSpanElement>("#q-total")!;
  const streakEl = host.querySelector<HTMLSpanElement>("#q-streak")!;
  const bestEl = host.querySelector<HTMLSpanElement>("#q-best")!;
  const promptEl = host.querySelector<HTMLDivElement>("#q-prompt")!;
  const choicesEl = host.querySelector<HTMLDivElement>("#q-choices")!;
  const feedbackEl = host.querySelector<HTMLDivElement>("#q-feedback")!;

  let score = 0;
  let total = 0;
  let streak = 0;
  let best = readBest();
  let answered = false;

  const kbd = (s: string) =>
    `<span class="text-green-400 bg-stone-800 border border-green-900 rounded px-1.5 py-0.5">${esc(s)}</span>`;

  const nextQuestion = () => {
    answered = false;
    feedbackEl.textContent = "";
    feedbackEl.className = "h-6 text-center font-mono text-sm";

    const subject = pick(FACTS);
    const distractors = sampleFacts(subject, 3);

    // Two directions: given the effect, pick the command; or given the
    // command, pick the effect.
    const askForCommand = Math.random() < 0.5;
    let correctText: string;
    let options: string[];

    if (askForCommand) {
      promptEl.innerHTML = `Which command will <span class="text-green-400">${esc(subject.desc)}</span>?`;
      correctText = subject.cmd;
      options = [subject.cmd, ...distractors.map((d) => d.cmd)];
    } else {
      promptEl.innerHTML = `What does ${kbd(subject.cmd)} do?`;
      correctText = subject.desc;
      options = [subject.desc, ...distractors.map((d) => d.desc)];
    }

    // Shuffle so the answer isn't always first.
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }

    choicesEl.innerHTML = "";
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = CHOICE_BASE;
      // Commands render as key-caps; descriptions as plain text.
      btn.innerHTML = askForCommand ? kbd(opt) : esc(opt);
      btn.onclick = () => {
        if (answered) return;
        answered = true;
        total++;
        totalEl.textContent = String(total);

        const correct = opt === correctText;
        const correctBtn = Array.from(choicesEl.children).find(
          (c) => (c as HTMLButtonElement).dataset.opt === correctText,
        ) as HTMLButtonElement;

        if (correct) {
          score++;
          streak++;
          scoreEl.textContent = String(score);
          streakEl.textContent = String(streak);
          btn.className = CHOICE_CORRECT;
          feedbackEl.textContent = streak >= 3 ? `🔥 ${streak} in a row!` : "Correct!";
          feedbackEl.className = "h-6 text-center font-mono text-sm text-green-400";
          if (streak > best) {
            best = streak;
            bestEl.textContent = String(best);
            writeBest(best);
          }
        } else {
          streak = 0;
          streakEl.textContent = "0";
          btn.className = CHOICE_WRONG;
          if (correctBtn) correctBtn.className = CHOICE_CORRECT;
          feedbackEl.innerHTML = askForCommand
            ? `Answer: ${kbd(correctText)}`
            : `Answer: <span class="text-green-400">${esc(correctText)}</span>`;
          feedbackEl.className = "h-6 text-center font-mono text-sm text-red-400";
        }

        Array.from(choicesEl.children).forEach((el) => {
          (el as HTMLButtonElement).disabled = true;
        });
        window.setTimeout(nextQuestion, correct ? 850 : 1700);
      };
      btn.dataset.opt = opt;
      choicesEl.appendChild(btn);
    });
  };

  nextQuestion();

  // No global listeners to clean up, but keep the mount contract uniform.
  let disposed = false;
  return () => {
    disposed = true;
    void disposed;
  };
}
