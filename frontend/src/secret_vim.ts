// A real Vim editor with no bundled dependency: CodeMirror 5 and its
// first-party Vim keymap are pulled from a CDN at page load — the same
// "serve it from a CDN, add nothing to package.json" trick secret_prettier.ts
// uses for Prettier. CM5 ships as a classic UMD bundle that augments a single
// `window.CodeMirror`, so the vim/dialog/search add-ons attach to the exact
// same instance (the CM6 ESM path silently fails to bind keys because esm.sh
// hands each module its own @codemirror/state copy).
//
// Two modes share the one editor: a free-form Playground, and Challenge — a
// "vim golf" mode that hands you a starting buffer and a target, counts your
// keystrokes, and congratulates you when the buffer matches the goal.
//
// The page also hosts three Vim-training mini-games, launched from the editor's
// own Ex line — type `:snake`, `:motions`, `:quiz` (or `:games` for a menu) and
// the game takes over the panel; Esc drops you back on the editor.

import { mountSnake } from "./secret_snake.ts";
import { mountMotions } from "./secret_motion.ts";
import { mountQuiz } from "./secret_vimquiz.ts";

const VER = "5.65.16";
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/codemirror/${VER}`;

const CSS = [`${CDN}/codemirror.min.css`, `${CDN}/addon/dialog/dialog.min.css`];
// Core must load before the add-ons, which all augment window.CodeMirror.
const CORE = `${CDN}/codemirror.min.js`;
const ADDONS = [
  `${CDN}/keymap/vim.min.js`,
  `${CDN}/addon/dialog/dialog.min.js`, // vim's ":" / "/" command line
  `${CDN}/addon/search/searchcursor.min.js`, // vim search (/, n, N, :s)
];

declare global {
  interface Window {
    CodeMirror: any;
  }
}

const loadCss = (href: string) =>
  new Promise<void>((resolve) => {
    if (document.querySelector(`link[href="${href}"]`)) return resolve();
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    l.onload = () => resolve();
    l.onerror = () => resolve(); // a missing stylesheet shouldn't block the editor
    document.head.appendChild(l);
  });

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });

let editorPromise: Promise<any> | null = null; // resolves to the CodeMirror instance

type GameName = "snake" | "motions" | "quiz" | "games";
// Set by the page each time it mounts; the Ex commands (defined once, below)
// call through this so `:snake` etc. reach the live page's game panel.
let gameLauncher: ((name: GameName) => void) | null = null;

const buildEditor = async (doc: string): Promise<any> => {
  CSS.forEach(loadCss);
  await loadScript(CORE);
  await Promise.all(ADDONS.map(loadScript));

  const CodeMirror = window.CodeMirror;

  // :w is a no-op here; :q (and :wq) drop you back on the secret menu.
  CodeMirror.Vim.defineEx("write", "w", () => {});
  CodeMirror.Vim.defineEx("quit", "q", () => window.navigate("/secret"));

  // Mini-games launch straight from the Ex line. Registered once (they persist
  // with the shared CodeMirror instance) and routed through `gameLauncher`,
  // which the currently-mounted page owns.
  CodeMirror.Vim.defineEx("snake", "snake", () => gameLauncher?.("snake"));
  CodeMirror.Vim.defineEx("motions", "motions", () => gameLauncher?.("motions"));
  CodeMirror.Vim.defineEx("quiz", "quiz", () => gameLauncher?.("quiz"));
  CodeMirror.Vim.defineEx("games", "games", () => gameLauncher?.("games"));

  const host = document.createElement("div");
  host.className = "vim-cm w-full";

  const cm = CodeMirror(host, {
    value: doc,
    keyMap: "vim",
    lineNumbers: true,
    showCursorWhenSelecting: true,
    lineWrapping: true,
  });
  cm.setSize("100%", "24rem");

  // Stash the wrapper so the page-render code can (re-)mount it.
  cm.__host = host;
  return cm;
};

const SAMPLE = `Welcome to Vim — the real thing, running in your browser.

This editor is CodeMirror with its first-party Vim keymap, both loaded
straight from a CDN at page load. Nothing is bundled into the site.

Try the classics:
  dd      delete a line            yy / p   yank & paste
  cw      change a word            x        delete a char
  A       append at line end       o        open a line below
  /word   search, then n / N       u        undo, Ctrl-r redo
  gg / G  top / bottom             v / V    visual / visual-line
  :w      "write" (no-op here)     :q       quit back to the menu

Press i to insert, Esc to return to normal mode. Have fun.
`;

// ---------------------------------------------------------------------------
// Challenge mode ("vim golf"): transform `start` into `target`. `par` is a
// friendly keystroke target — beat it and you've done well.
// ---------------------------------------------------------------------------

interface Challenge {
  title: string;
  hint: string;
  start: string;
  target: string;
  par: number;
}

const CHALLENGES: Challenge[] = [
  {
    title: "Delete the debug line",
    hint: "Put the cursor on the console.log line and remove the whole line.",
    par: 4,
    start: `function add(a, b) {
  console.log("debugging");
  return a + b;
}`,
    target: `function add(a, b) {
  return a + b;
}`,
  },
  {
    title: "Swap two lines",
    hint: "The imports are in the wrong order — put them right.",
    par: 5,
    start: `import { z } from "./z";
import { a } from "./a";`,
    target: `import { a } from "./a";
import { z } from "./z";`,
  },
  {
    title: "Shout the word",
    hint: "Make the single word UPPERCASE (try gU, or ~, or a change).",
    par: 4,
    start: `warning`,
    target: `WARNING`,
  },
  {
    title: "Fill in the blanks",
    hint: "Append a semicolon to the end of every line.",
    par: 9,
    start: `let x = 1
let y = 2
let z = 3`,
    target: `let x = 1;
let y = 2;
let z = 3;`,
  },
  {
    title: "Reverse the list",
    hint: "Flip the three items so they read c, b, a.",
    par: 8,
    start: `a
b
c`,
    target: `c
b
a`,
  },
  {
    title: "Kill the duplicates",
    hint: "There are three copies of the line — leave just one.",
    par: 6,
    start: `keep me
keep me
keep me`,
    target: `keep me`,
  },
];

// Trailing whitespace / a stray final newline shouldn't fail an otherwise
// correct answer, so compare with trailing blank lines trimmed off each line.
const normalize = (s: string): string =>
  s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Vim
    </h1>
  </a>

  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Real CodeMirror + Vim, fetched from a CDN on load — no bundled deps.
    Press <span class="text-green-500">i</span> to insert,
    <span class="text-green-500">Esc</span> for normal, <span class="text-green-500">:q</span> to leave.
    Train with <span class="text-green-500">:snake</span>,
    <span class="text-green-500">:motions</span>, <span class="text-green-500">:quiz</span>.
  </p>

  <div id="vim-mode" class="mt-6 flex gap-2 font-mono text-sm">
    <button data-mode="playground" class="border rounded px-4 py-2 cursor-pointer transition-colors">Playground</button>
    <button data-mode="challenge" class="border rounded px-4 py-2 cursor-pointer transition-colors">Challenge</button>
  </div>

  <!-- Mini-game panel — shown while a game (launched from the Ex line) runs. -->
  <div id="vim-game" class="hidden w-full max-w-3xl mt-6 flex-col gap-3">
    <div class="flex items-center justify-between gap-3">
      <div id="vg-title" class="text-green-300 text-lg font-bold"></div>
      <button id="vg-back"
        class="border border-green-900 hover:border-green-600 text-green-300 font-mono text-sm px-4 py-2 rounded cursor-pointer transition-colors">
        ← Editor (Esc)
      </button>
    </div>
    <div id="vg-host" class="bg-stone-900 border border-green-900 rounded p-4"></div>
  </div>

  <!-- Challenge control panel — only shown in Challenge mode. -->
  <div id="vim-challenge" class="hidden w-full max-w-3xl mt-6 flex-col gap-3">
    <div class="flex items-center justify-between gap-3 font-mono text-sm">
      <div class="text-green-700">
        Challenge <span id="vc-index" class="text-green-400">1</span> / ${CHALLENGES.length}
      </div>
      <div class="flex gap-4">
        <span class="text-green-700">Keys: <span id="vc-keys" class="text-green-400">0</span></span>
        <span class="text-green-700">Par: <span id="vc-par" class="text-green-400">—</span></span>
      </div>
    </div>

    <div class="bg-stone-900 border border-green-900 rounded p-4 flex flex-col gap-2">
      <div id="vc-title" class="text-green-300 text-lg"></div>
      <div id="vc-hint" class="text-green-700 text-sm font-mono"></div>
    </div>

    <div class="bg-stone-900 border border-green-900 rounded p-4">
      <div class="text-green-700 text-xs uppercase tracking-widest font-mono mb-2">Target</div>
      <pre id="vc-target" class="text-green-400 font-mono text-sm whitespace-pre-wrap"></pre>
    </div>

    <div class="flex flex-wrap items-center gap-2 font-mono text-sm">
      <button id="vc-reset" class="border border-green-900 hover:border-green-600 text-green-300 px-4 py-2 rounded cursor-pointer transition-colors">Reset</button>
      <button id="vc-prev" class="border border-green-900 hover:border-green-600 text-green-300 px-4 py-2 rounded cursor-pointer transition-colors">Prev</button>
      <button id="vc-next" class="border border-green-900 hover:border-green-600 text-green-300 px-4 py-2 rounded cursor-pointer transition-colors">Next</button>
      <div id="vc-status" class="ml-auto h-6 leading-6"></div>
    </div>
  </div>

  <div id="vim-host"
    class="w-full max-w-3xl mt-6 bg-stone-900 border border-green-900 focus-within:border-green-600 rounded overflow-hidden">
    <div id="vim-loading" class="px-4 py-16 text-center text-green-800 font-mono text-sm">
      Loading editor…
    </div>
  </div>
</div>
`;

  const host = app.querySelector("#vim-host") as HTMLElement;
  const challengePanel = app.querySelector<HTMLDivElement>("#vim-challenge")!;
  const modeRow = app.querySelector<HTMLDivElement>("#vim-mode")!;
  const gamePanel = app.querySelector<HTMLDivElement>("#vim-game")!;
  const gameHost = app.querySelector<HTMLDivElement>("#vg-host")!;
  const gameTitle = app.querySelector<HTMLDivElement>("#vg-title")!;
  const modeBtns = Array.from(
    app.querySelectorAll<HTMLButtonElement>("#vim-mode button"),
  );
  const idxEl = app.querySelector<HTMLSpanElement>("#vc-index")!;
  const keysEl = app.querySelector<HTMLSpanElement>("#vc-keys")!;
  const parEl = app.querySelector<HTMLSpanElement>("#vc-par")!;
  const titleEl = app.querySelector<HTMLDivElement>("#vc-title")!;
  const hintEl = app.querySelector<HTMLDivElement>("#vc-hint")!;
  const targetEl = app.querySelector<HTMLPreElement>("#vc-target")!;
  const statusEl = app.querySelector<HTMLDivElement>("#vc-status")!;

  type Mode = "playground" | "challenge";
  let mode: Mode = "playground";
  let challengeIdx = 0;
  let keystrokes = 0;
  let solved = false;
  let playgroundBuffer = SAMPLE; // preserved when hopping into a challenge
  let cm: any = null;

  const paintModeButtons = () => {
    for (const btn of modeBtns) {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle("border-green-500", on);
      btn.classList.toggle("text-green-300", on);
      btn.classList.toggle("border-green-900", !on);
      btn.classList.toggle("text-green-700", !on);
    }
  };

  const setStatus = (text: string, cls: string) => {
    statusEl.textContent = text;
    statusEl.className = `ml-auto h-6 leading-6 font-mono text-sm ${cls}`;
  };

  // Load a challenge into the editor and reset its counters.
  const loadChallenge = () => {
    const c = CHALLENGES[challengeIdx];
    idxEl.textContent = String(challengeIdx + 1);
    parEl.textContent = String(c.par);
    titleEl.textContent = c.title;
    hintEl.textContent = c.hint;
    targetEl.textContent = c.target;
    keystrokes = 0;
    keysEl.textContent = "0";
    solved = false;
    setStatus("", "");
    if (cm) {
      cm.setValue(c.start);
      cm.setCursor(0, 0);
      cm.focus();
    }
  };

  // On every edit in challenge mode, check whether the buffer matches the goal.
  const checkSolved = () => {
    if (mode !== "challenge" || solved || !cm) return;
    const c = CHALLENGES[challengeIdx];
    if (normalize(cm.getValue()) === normalize(c.target)) {
      solved = true;
      const verdict =
        keystrokes <= c.par
          ? `🏆 Solved in ${keystrokes} — par ${c.par}. Nice!`
          : `✅ Solved in ${keystrokes} (par ${c.par}).`;
      setStatus(verdict, "text-green-400");
    }
  };

  const enterMode = (next: Mode) => {
    if (next === mode) return;
    if (!cm) {
      mode = next; // remember the intent; applied once the editor resolves
      paintModeButtons();
      challengePanel.classList.toggle("hidden", next !== "challenge");
      challengePanel.classList.toggle("flex", next === "challenge");
      return;
    }
    if (mode === "playground") playgroundBuffer = cm.getValue();
    mode = next;
    paintModeButtons();
    challengePanel.classList.toggle("hidden", next !== "challenge");
    challengePanel.classList.toggle("flex", next === "challenge");
    if (next === "challenge") {
      loadChallenge();
    } else {
      cm.setValue(playgroundBuffer);
      cm.focus();
    }
  };

  for (const btn of modeBtns) {
    btn.onclick = () => enterMode(btn.dataset.mode as Mode);
  }
  app.querySelector<HTMLButtonElement>("#vc-reset")!.onclick = () => loadChallenge();
  app.querySelector<HTMLButtonElement>("#vc-prev")!.onclick = () => {
    challengeIdx = (challengeIdx - 1 + CHALLENGES.length) % CHALLENGES.length;
    loadChallenge();
  };
  app.querySelector<HTMLButtonElement>("#vc-next")!.onclick = () => {
    challengeIdx = (challengeIdx + 1) % CHALLENGES.length;
    loadChallenge();
  };

  paintModeButtons();

  // --- Mini-games (launched from the Ex line via `gameLauncher`) -----------
  const GAME_TITLES: Record<Exclude<GameName, "games">, string> = {
    snake: "Vim Snake",
    motions: "Vim Motions",
    quiz: "Vim Quiz",
  };
  const GAME_MOUNTERS: Record<Exclude<GameName, "games">, (h: HTMLElement) => () => void> = {
    snake: mountSnake,
    motions: mountMotions,
    quiz: mountQuiz,
  };

  let disposeGame: (() => void) | null = null;

  const returnToEditor = () => {
    if (disposeGame) {
      disposeGame();
      disposeGame = null;
    }
    gameHost.innerHTML = "";
    gamePanel.classList.add("hidden");
    gamePanel.classList.remove("flex");
    window.removeEventListener("keydown", onGameEscape, true);
    // Restore the editor + the mode/challenge UI that a game had hidden.
    modeRow.classList.remove("hidden");
    host.classList.remove("hidden");
    challengePanel.classList.toggle("hidden", mode !== "challenge");
    challengePanel.classList.toggle("flex", mode === "challenge");
    if (cm) cm.focus();
  };

  // Esc leaves a running game. Capture-phase + guarded so it can't fight the
  // editor's own Esc (the editor is hidden while a game is open).
  function onGameEscape(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      returnToEditor();
    }
  }

  // A tiny launcher menu for `:games`.
  const showGamesMenu = () => {
    gameTitle.textContent = "Vim Training";
    gameHost.innerHTML = `
      <div class="flex flex-col gap-2 font-mono text-sm">
        <p class="text-green-800">Launch from here, or type the command on the editor's Ex line.</p>
        <button data-game="snake" class="text-left border border-green-900 hover:border-green-600 text-green-300 px-4 py-2 rounded cursor-pointer transition-colors"><span class="text-green-500">:snake</span> — steer with hjkl</button>
        <button data-game="motions" class="text-left border border-green-900 hover:border-green-600 text-green-300 px-4 py-2 rounded cursor-pointer transition-colors"><span class="text-green-500">:motions</span> — chase a target with w b e f 0 $ gg G</button>
        <button data-game="quiz" class="text-left border border-green-900 hover:border-green-600 text-green-300 px-4 py-2 rounded cursor-pointer transition-colors"><span class="text-green-500">:quiz</span> — command vocabulary drill</button>
      </div>`;
    gameHost.querySelectorAll<HTMLButtonElement>("[data-game]").forEach((b) => {
      b.onclick = () => launchGame(b.dataset.game as GameName);
    });
  };

  const launchGame = (name: GameName) => {
    if (!cm) return; // editor still loading — nothing to launch over yet
    if (disposeGame) {
      disposeGame();
      disposeGame = null;
    }
    // Hide the editor + mode/challenge UI while the game owns the panel.
    host.classList.add("hidden");
    challengePanel.classList.add("hidden");
    challengePanel.classList.remove("flex");
    modeRow.classList.add("hidden");
    gamePanel.classList.remove("hidden");
    gamePanel.classList.add("flex");
    gameHost.innerHTML = "";
    window.addEventListener("keydown", onGameEscape, true);

    if (name === "games") {
      showGamesMenu();
      return;
    }
    gameTitle.textContent = GAME_TITLES[name];
    disposeGame = GAME_MOUNTERS[name](gameHost);
  };

  gameLauncher = launchGame;
  app.querySelector<HTMLButtonElement>("#vg-back")!.onclick = returnToEditor;

  // Build the editor once and reuse it across navigations (preserves the
  // buffer). The CDN fetch starts here, on first visit to /secret/vim.
  if (!editorPromise) editorPromise = buildEditor(playgroundBuffer);

  editorPromise
    .then((editor) => {
      cm = editor;
      // Guard against the user navigating away before the CDN load resolved.
      if (!document.body.contains(host)) return;
      host.innerHTML = "";
      host.appendChild(cm.__host);
      cm.refresh(); // CM needs a re-measure after being re-parented
      cm.focus();

      // Count real keystrokes (ignore lone modifier presses) while a challenge
      // is running, and re-check the buffer against the target after each edit.
      const wrapper = cm.getWrapperElement() as HTMLElement;
      wrapper.addEventListener(
        "keydown",
        (e: KeyboardEvent) => {
          if (mode !== "challenge" || solved) return;
          if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
          keystrokes++;
          keysEl.textContent = String(keystrokes);
        },
        true,
      );
      cm.on("change", checkSolved);

      // If the user clicked into Challenge before the editor resolved, honour it.
      if (mode === "challenge") loadChallenge();
    })
    .catch((err) => {
      const loading = host.querySelector("#vim-loading");
      if (loading)
        loading.textContent =
          "Failed to load the editor from the CDN: " +
          (err instanceof Error ? err.message : String(err));
    });
};
