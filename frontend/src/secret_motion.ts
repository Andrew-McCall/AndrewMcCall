// Vim Motions — a cursor-chase trainer. A block of text is shown as a grid;
// a target character is highlighted, and you must land the cursor on it using
// real Vim motions in as few keystrokes as possible. It implements the actual
// semantics of h j k l, w b e, 0 $, gg G and f{char}, so the muscle memory you
// build here transfers straight to Vim. Self-contained, no dependencies.
//
// Mounts into a host element handed in by the Vim page (`:motions`);
// `mountMotions` returns a dispose fn that removes its key listener.

type Pos = { line: number; col: number };

// A few buffers with a mix of words, punctuation and indentation so that word
// motions (w/b/e) and find (f) actually have something to chew on.
const BUFFERS = [
  `function greet(name) {
  const msg = "hi, " + name;
  console.log(msg);
  return msg.length;
}`,
  `const nums = [3, 14, 15, 92, 65];
let total = 0;
for (const n of nums) {
  total += n * 2;
}`,
  `# shopping list
- apples (6)
- bread
- coffee beans, dark roast
- 2x milk`,
  `class Point {
  x = 0;
  y = 0;
  add(other) {
    return new Point();
  }
}`,
];

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

type CharType = "word" | "blank" | "punct";
const typeOf = (ch: string): CharType =>
  /\w/.test(ch) ? "word" : /\s/.test(ch) ? "blank" : "punct";

export function mountMotions(host: HTMLElement): () => void {
  host.innerHTML = `
<div class="flex flex-col items-center">
  <p class="text-green-800 font-mono text-sm text-center max-w-xl">
    Move the <span class="text-green-400">cursor</span> onto the
    <span class="text-red-400">target</span> using Vim motions — in as few
    keystrokes as you can. No mouse.
  </p>

  <div class="flex justify-between w-full max-w-2xl mt-6 font-mono text-sm text-green-700">
    <div>Round: <span id="mo-round" class="text-green-400">1</span></div>
    <div>Keys this target: <span id="mo-keys" class="text-green-400">0</span></div>
    <div>Total keys: <span id="mo-total" class="text-green-400">0</span></div>
  </div>

  <div id="mo-grid"
    class="w-full max-w-2xl mt-3 bg-stone-900 border border-green-900 rounded p-4 overflow-x-auto font-mono text-base leading-7"></div>

  <div id="mo-flash" class="h-6 mt-2 font-mono text-sm text-green-400"></div>

  <div class="w-full max-w-2xl mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs text-green-700">
    <div class="border border-green-900 rounded px-3 py-1"><span class="text-green-400">h j k l</span> — move</div>
    <div class="border border-green-900 rounded px-3 py-1"><span class="text-green-400">w b e</span> — by word</div>
    <div class="border border-green-900 rounded px-3 py-1"><span class="text-green-400">0 $</span> — line ends</div>
    <div class="border border-green-900 rounded px-3 py-1"><span class="text-green-400">gg G</span> — top / bottom</div>
    <div class="border border-green-900 rounded px-3 py-1 col-span-2 sm:col-span-4 text-center">
      <span class="text-green-400">f</span> then a character — jump to it on this line
    </div>
  </div>
</div>`;

  const gridEl = host.querySelector<HTMLDivElement>("#mo-grid")!;
  const roundEl = host.querySelector<HTMLSpanElement>("#mo-round")!;
  const keysEl = host.querySelector<HTMLSpanElement>("#mo-keys")!;
  const totalEl = host.querySelector<HTMLSpanElement>("#mo-total")!;
  const flashEl = host.querySelector<HTMLDivElement>("#mo-flash")!;

  let lines: string[] = [];
  // Flat view of the buffer (with '\n' between lines) for word-motion logic,
  // plus maps back and forth between a flat index and a {line, col}.
  let flat = "";
  let posOfFlat: (Pos | null)[] = [];
  let flatOfPos: number[][] = [];

  let cursor: Pos = { line: 0, col: 0 };
  let target: Pos = { line: 0, col: 0 };
  let round = 1;
  let keys = 0;
  let total = 0;
  let pending: null | "f" | "g" = null;

  const buildMaps = () => {
    flat = "";
    posOfFlat = [];
    flatOfPos = lines.map(() => []);
    lines.forEach((line, li) => {
      for (let ci = 0; ci < line.length; ci++) {
        flatOfPos[li][ci] = flat.length;
        posOfFlat.push({ line: li, col: ci });
        flat += line[ci];
      }
      if (li < lines.length - 1) {
        posOfFlat.push(null); // the '\n' has no cursor cell
        flat += "\n";
      }
    });
  };

  const lineLen = (li: number) => lines[li].length;
  // Vim keeps the cursor on a real character; empty lines allow col 0.
  const clampCol = (li: number, col: number) => Math.max(0, Math.min(col, Math.max(0, lineLen(li) - 1)));

  // Convert a flat index to a cursor position, skipping back off any '\n'.
  const posFromFlat = (i: number): Pos => {
    i = Math.max(0, Math.min(i, flat.length - 1));
    while (i > 0 && posOfFlat[i] === null) i--;
    return posOfFlat[i] ?? { line: 0, col: 0 };
  };
  const flatFromCursor = (): number => flatOfPos[cursor.line][cursor.col] ?? 0;

  // --- word motions over the flat string ---
  const nextWord = (i: number): number => {
    const n = flat.length;
    if (i >= n - 1) return n - 1;
    const t = typeOf(flat[i]);
    if (t !== "blank") while (i < n && typeOf(flat[i]) === t) i++;
    while (i < n && typeOf(flat[i]) === "blank") i++;
    return Math.min(i, n - 1);
  };
  const prevWord = (i: number): number => {
    if (i <= 0) return 0;
    i--;
    while (i > 0 && typeOf(flat[i]) === "blank") i--;
    const t = typeOf(flat[i]);
    while (i > 0 && typeOf(flat[i - 1]) === t) i--;
    return i;
  };
  const endWord = (i: number): number => {
    const n = flat.length;
    i++;
    while (i < n && typeOf(flat[i]) === "blank") i++;
    const t = typeOf(flat[i]);
    while (i + 1 < n && typeOf(flat[i + 1]) === t) i++;
    return Math.min(i, n - 1);
  };

  const render = () => {
    gridEl.innerHTML = lines
      .map((line, li) => {
        // Render at least one cell wide so blank/short lines still show a caret.
        const cells: string[] = [];
        const width = Math.max(line.length, 1);
        for (let ci = 0; ci < width; ci++) {
          const ch = ci < line.length ? line[ci] : " ";
          const isCursor = li === cursor.line && ci === cursor.col;
          const isTarget = li === target.line && ci === target.col;
          let cls = "";
          if (isCursor) cls = "bg-green-500 text-stone-950 rounded-sm";
          else if (isTarget) cls = "bg-red-500/30 text-red-300 outline outline-1 outline-red-500 rounded-sm";
          cells.push(cls ? `<span class="${cls}">${esc(ch)}</span>` : esc(ch));
        }
        return `<div class="whitespace-pre">${cells.join("")}</div>`;
      })
      .join("");
  };

  const newTarget = () => {
    // Pick a non-blank cell that isn't where the cursor already is.
    const candidates: Pos[] = [];
    lines.forEach((line, li) => {
      for (let ci = 0; ci < line.length; ci++) {
        if (typeOf(line[ci]) !== "blank" && !(li === cursor.line && ci === cursor.col)) {
          candidates.push({ line: li, col: ci });
        }
      }
    });
    target = candidates[Math.floor(Math.random() * candidates.length)] ?? { line: 0, col: 0 };
    keys = 0;
    keysEl.textContent = "0";
  };

  const loadBuffer = () => {
    lines = BUFFERS[(round - 1) % BUFFERS.length].split("\n");
    buildMaps();
    cursor = { line: 0, col: 0 };
    newTarget();
    render();
  };

  const reachedTarget = () => cursor.line === target.line && cursor.col === target.col;

  const onSolved = () => {
    flashEl.textContent = `Reached it in ${keys} key${keys === 1 ? "" : "s"}! ✅`;
    round++;
    roundEl.textContent = String(round);
    // Every buffer gets a fresh target; advance the buffer each round.
    loadBuffer();
    render();
  };

  const move = (fn: () => void) => {
    fn();
    keys++;
    total++;
    keysEl.textContent = String(keys);
    totalEl.textContent = String(total);
    render();
    if (reachedTarget()) onSolved();
  };

  const onKey = (e: KeyboardEvent) => {
    const k = e.key;

    // Two-stage motions first: f{char} and g→gg.
    if (pending === "f") {
      pending = null;
      if (k.length === 1) {
        e.preventDefault();
        move(() => {
          const line = lines[cursor.line];
          const at = line.indexOf(k, cursor.col + 1);
          if (at >= 0) cursor.col = at;
        });
      }
      return;
    }
    if (pending === "g") {
      pending = null;
      if (k === "g") {
        e.preventDefault();
        move(() => {
          cursor = { line: 0, col: 0 };
        });
      }
      return;
    }

    switch (k) {
      case "h": move(() => (cursor.col = clampCol(cursor.line, cursor.col - 1))); break;
      case "l": move(() => (cursor.col = clampCol(cursor.line, cursor.col + 1))); break;
      case "j":
        move(() => {
          cursor.line = Math.min(lines.length - 1, cursor.line + 1);
          cursor.col = clampCol(cursor.line, cursor.col);
        });
        break;
      case "k":
        move(() => {
          cursor.line = Math.max(0, cursor.line - 1);
          cursor.col = clampCol(cursor.line, cursor.col);
        });
        break;
      case "0": move(() => (cursor.col = 0)); break;
      case "$": move(() => (cursor.col = clampCol(cursor.line, lineLen(cursor.line) - 1))); break;
      case "w": move(() => (cursor = posFromFlat(nextWord(flatFromCursor())))); break;
      case "b": move(() => (cursor = posFromFlat(prevWord(flatFromCursor())))); break;
      case "e": move(() => (cursor = posFromFlat(endWord(flatFromCursor())))); break;
      case "G": move(() => (cursor = { line: lines.length - 1, col: 0 })); break;
      case "g": pending = "g"; e.preventDefault(); return;
      case "f": pending = "f"; e.preventDefault(); return;
      default:
        return; // ignore everything else
    }
    e.preventDefault();
  };

  window.addEventListener("keydown", onKey);
  loadBuffer();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("keydown", onKey);
  };
}
