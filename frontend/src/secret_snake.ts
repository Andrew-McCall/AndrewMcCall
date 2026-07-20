// Vim Snake — the classic, but you steer with Vim's home-row motion keys:
// h ← j ↓ k ↑ l →. It's a painless way to burn hjkl into muscle memory.
//
// Not a page of its own: it mounts into a host element handed in by the Vim
// page, which launches it from the editor's Ex line (`:snake`). `mountSnake`
// returns a dispose fn that tears down the loop and listeners.

const GRID = 20; // cells per side
const BEST_KEY = "vim-snake-best";

type Pt = { x: number; y: number };

const readBest = (): number => {
  try {
    return parseInt(localStorage.getItem(BEST_KEY) || "0") || 0;
  } catch {
    return 0;
  }
};

const writeBest = (n: number) => {
  try {
    localStorage.setItem(BEST_KEY, String(n));
  } catch {
    /* localStorage unavailable — best just won't persist */
  }
};

export function mountSnake(host: HTMLElement): () => void {
  host.innerHTML = `
<div class="flex flex-col items-center">
  <p class="text-green-800 font-mono text-sm text-center max-w-xl">
    Steer with Vim's motion keys —
    <span class="text-green-500">h</span> left,
    <span class="text-green-500">j</span> down,
    <span class="text-green-500">k</span> up,
    <span class="text-green-500">l</span> right.
    <span class="text-green-500">Space</span> pauses.
  </p>

  <div class="flex justify-between w-full max-w-md mt-4 font-mono text-sm text-green-700">
    <div>Score: <span id="sn-score" class="text-green-400">0</span></div>
    <div>Best: <span id="sn-best" class="text-green-400">${readBest()}</span></div>
  </div>

  <div class="relative mt-3">
    <canvas id="sn-canvas" class="bg-stone-900 border border-green-900 rounded"
      style="image-rendering: pixelated; width: min(80vw, 24rem); height: min(80vw, 24rem);"></canvas>
    <div id="sn-overlay"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-950/80 rounded text-center px-4">
      <div id="sn-overlay-text" class="text-green-300 font-mono"></div>
      <button id="sn-start"
        class="border border-green-700 hover:border-green-400 text-green-300 font-bold px-5 py-2 rounded cursor-pointer transition-colors">
        Start
      </button>
    </div>
  </div>

  <div class="mt-4 grid grid-cols-4 gap-2 font-mono text-xs text-green-700">
    <div class="border border-green-900 rounded px-3 py-1 text-center"><span class="text-green-400">h</span> ←</div>
    <div class="border border-green-900 rounded px-3 py-1 text-center"><span class="text-green-400">j</span> ↓</div>
    <div class="border border-green-900 rounded px-3 py-1 text-center"><span class="text-green-400">k</span> ↑</div>
    <div class="border border-green-900 rounded px-3 py-1 text-center"><span class="text-green-400">l</span> →</div>
  </div>
</div>`;

  const canvas = host.querySelector<HTMLCanvasElement>("#sn-canvas")!;
  const ctx = canvas.getContext("2d")!;
  const scoreEl = host.querySelector<HTMLSpanElement>("#sn-score")!;
  const bestEl = host.querySelector<HTMLSpanElement>("#sn-best")!;
  const overlay = host.querySelector<HTMLDivElement>("#sn-overlay")!;
  const overlayText = host.querySelector<HTMLDivElement>("#sn-overlay-text")!;
  const startBtn = host.querySelector<HTMLButtonElement>("#sn-start")!;

  // Backing store is CELL pixels per cell; CSS scales it (pixelated) so the
  // draw code can work in tidy grid coordinates.
  const CELL = 24;
  canvas.width = GRID * CELL;
  canvas.height = GRID * CELL;

  let snake: Pt[] = [];
  let dir: Pt = { x: 1, y: 0 };
  let nextDir: Pt = { x: 1, y: 0 };
  let food: Pt = { x: 0, y: 0 };
  let score = 0;
  let best = readBest();
  let running = false;
  let timer: number | null = null;

  const eq = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;

  const placeFood = () => {
    // Reject spots that land on the snake so food is always reachable.
    let p: Pt;
    do {
      p = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
    } while (snake.some((s) => eq(s, p)));
    food = p;
  };

  const draw = () => {
    ctx.fillStyle = "#1c1917"; // stone-900
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#ef4444"; // food — red-500
    ctx.fillRect(food.x * CELL + 3, food.y * CELL + 3, CELL - 6, CELL - 6);

    snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? "#4ade80" : "#16a34a"; // head green-400, body green-600
      ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
    });
  };

  const gameOver = () => {
    running = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      writeBest(best);
    }
    overlayText.innerHTML = `Game over — you scored <span class="text-green-400">${score}</span>.`;
    startBtn.textContent = "Play again";
    overlay.classList.remove("hidden");
  };

  const step = () => {
    dir = nextDir;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

    // Walls and self-collision end the run.
    if (
      head.x < 0 ||
      head.y < 0 ||
      head.x >= GRID ||
      head.y >= GRID ||
      snake.some((s) => eq(s, head))
    ) {
      gameOver();
      return;
    }

    snake.unshift(head);
    if (eq(head, food)) {
      score++;
      scoreEl.textContent = String(score);
      placeFood();
    } else {
      snake.pop(); // no growth — move by dropping the tail
    }
    draw();
  };

  const start = () => {
    snake = [
      { x: 8, y: 10 },
      { x: 7, y: 10 },
      { x: 6, y: 10 },
    ];
    dir = { x: 1, y: 0 };
    nextDir = { x: 1, y: 0 };
    score = 0;
    scoreEl.textContent = "0";
    placeFood();
    draw();
    running = true;
    overlay.classList.add("hidden");
    if (timer !== null) clearInterval(timer);
    timer = window.setInterval(step, 110);
  };

  const setDir = (x: number, y: number) => {
    // Ignore a 180° reversal, which would instantly collide with the neck.
    if (dir.x + x === 0 && dir.y + y === 0) return;
    nextDir = { x, y };
  };

  const pause = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      running = false;
      overlayText.textContent = "Paused";
      startBtn.textContent = "Resume";
      overlay.classList.remove("hidden");
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (["h", "j", "k", "l", " "].includes(k)) e.preventDefault();
    if (!running && timer === null) {
      if (k === " " || k === "enter") startBtn.click();
      return;
    }
    switch (k) {
      case "k": setDir(0, -1); break;
      case "j": setDir(0, 1); break;
      case "h": setDir(-1, 0); break;
      case "l": setDir(1, 0); break;
      case " ": pause(); break;
    }
  };

  window.addEventListener("keydown", onKey);

  startBtn.onclick = () => {
    // Resume from a pause if one is pending; otherwise start fresh.
    if (startBtn.textContent === "Resume") {
      running = true;
      overlay.classList.add("hidden");
      timer = window.setInterval(step, 110);
    } else {
      start();
    }
  };

  // Initial idle frame behind the overlay.
  snake = [{ x: 8, y: 10 }];
  placeFood();
  draw();
  overlayText.textContent = "Ready?";

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("keydown", onKey);
    if (timer !== null) clearInterval(timer);
  };
}
