import "./life.css";
import { $, calm } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

const PITCH = 13;
const CELL = 12;
const MIN_SIDE = 4;
const SETTLED_AFTER = 3;
const FADE_MS = 140;
const DEAD = 0.1;
const HOVER = 0.34;

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" id="life-run" type="button">Pause</button>
    <button class="btn" id="life-step" type="button">Step</button>
    <button class="btn" id="life-rand" type="button" data-restart>Restart</button>
    <button class="btn" id="life-clear" type="button">Clear</button>
    <span class="tag" id="life-gen">gen 0</span>
  </div>
  <div class="life" id="life" role="img"
    aria-label="Game of Life grid. Click or drag to draw cells.">
    <canvas class="life-grid" id="life-grid"></canvas>
  </div>`;

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const box = $("#life", host.body);
  const grid = $<HTMLCanvasElement>("#life-grid", host.body);
  const context = grid.getContext("2d")!;
  const runButton = $("#life-run", host.body);
  const generationLabel = $("#life-gen", host.body);

  let columns = 0;
  let rows = 0;
  let alive: Uint8Array = new Uint8Array(0);
  let shown: Float32Array = new Float32Array(0);
  let scale = 1;
  let hover = -1;
  let lastFrame = 0;
  const fading = new Set<number>();
  let generation = 0;
  let pen: number | null = null;
  let still = 0;
  let seeded = false;
  let running = !calm();
  let random: Rng = Math.random;
  let resizes = 0;

  function label(): void {
    generationLabel.textContent = `gen ${generation}`;
    generationLabel.style.fontStyle = still >= SETTLED_AFTER ? "italic" : "";
    runButton.textContent = running ? "Pause" : "Play";
  }

  const wanted = (index: number): number =>
    alive[index] ? 1 : index === hover ? HOVER : DEAD;

  function paint(index: number): void {
    const left = Math.round((index % columns) * PITCH * scale);
    const top = Math.round(Math.floor(index / columns) * PITCH * scale);
    const side = Math.max(1, Math.round(CELL * scale));
    context.clearRect(left, top, side, side);
    context.globalAlpha = shown[index];
    context.fillRect(left, top, side, side);
  }

  function touch(index: number): void {
    if (index < 0 || index >= shown.length) return;
    if (!calm()) {
      fading.add(index);
      return;
    }
    shown[index] = wanted(index);
    paint(index);
  }

  function repaint(): void {
    context.fillStyle = getComputedStyle(grid).color;
    fading.clear();
    for (let i = 0; i < shown.length; i++) {
      shown[i] = wanted(i);
      paint(i);
    }
  }

  function fade(time: number): void {
    const moved = ((time - lastFrame) / FADE_MS) * (1 - DEAD);
    lastFrame = time;
    for (const index of fading) {
      const target = wanted(index);
      const gap = target - shown[index];
      if (Math.abs(gap) <= moved) {
        shown[index] = target;
        fading.delete(index);
      } else {
        shown[index] += Math.sign(gap) * moved;
      }
      paint(index);
    }
  }

  function set(index: number, value: number): void {
    if (alive[index] === value) return;
    alive[index] = value;
    touch(index);
    still = 0;
  }

  function fill(value: () => number): void {
    for (let i = 0; i < alive.length; i++) set(i, value());
    generation = 0;
    still = 0;
    label();
  }

  function scatter(): void {
    fill(() => (random() < 0.3 ? 1 : 0));
  }

  function resized(newColumns: number, newRows: number): Uint8Array {
    const next = new Uint8Array(newColumns * newRows);
    for (let y = 0; y < Math.min(rows, newRows); y++) {
      for (let x = 0; x < Math.min(columns, newColumns); x++) {
        next[y * newColumns + x] = alive[y * columns + x];
      }
    }
    return next;
  }

  function build(): void {
    const style = getComputedStyle(box);
    const width = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const newColumns = Math.floor((width + 1) / PITCH);
    const newRows = Math.floor((height + 1) / PITCH);
    if (newColumns < MIN_SIDE || newRows < MIN_SIDE) return;
    if (newColumns === columns && newRows === rows && scale === devicePixelRatio) return;
    const first = !columns;
    alive = resized(newColumns, newRows);
    columns = newColumns;
    rows = newRows;
    scale = devicePixelRatio;
    hover = -1;
    shown = new Float32Array(alive.length);
    grid.style.width = `${columns * PITCH - 1}px`;
    grid.style.height = `${rows * PITCH - 1}px`;
    grid.width = Math.round((columns * PITCH - 1) * scale);
    grid.height = Math.round((rows * PITCH - 1) * scale);
    repaint();
    if (!first) return;
    grid.classList.add("wait");
    host.later(500, () => {
      seeded = true;
      grid.classList.remove("wait");
      scatter();
    });
  }

  function nextGeneration(): Uint8Array {
    const next = new Uint8Array(alive.length);
    for (let y = 0; y < rows; y++) {
      const up = ((y + rows - 1) % rows) * columns;
      const mid = y * columns;
      const down = ((y + 1) % rows) * columns;
      for (let x = 0; x < columns; x++) {
        const left = (x + columns - 1) % columns;
        const right = (x + 1) % columns;
        const neighbours =
          alive[up + left] +
          alive[up + x] +
          alive[up + right] +
          alive[mid + left] +
          alive[mid + right] +
          alive[down + left] +
          alive[down + x] +
          alive[down + right];
        const lives = neighbours === 3 || (neighbours === 2 && alive[mid + x] === 1);
        next[mid + x] = lives ? 1 : 0;
      }
    }
    return next;
  }

  function step(): void {
    if (!columns) return;
    const next = nextGeneration();
    let changed = false;
    for (let i = 0; i < next.length; i++) {
      if (alive[i] === next[i]) continue;
      changed = true;
      set(i, next[i]);
    }
    still = changed ? 0 : still + 1;
    if (still >= SETTLED_AFTER) {
      running = false;
      if (still === SETTLED_AFTER) generation -= 2;
      label();
      return;
    }
    generation++;
    label();
  }

  function cellAt(event: PointerEvent): number {
    const edge = grid.getBoundingClientRect();
    const x = Math.floor((event.clientX - edge.left) / PITCH);
    const y = Math.floor((event.clientY - edge.top) / PITCH);
    if (x < 0 || y < 0 || x >= columns || y >= rows) return -1;
    return y * columns + x;
  }

  function point(index: number): void {
    if (index === hover) return;
    const old = hover;
    hover = index;
    touch(old);
    touch(index);
  }

  function draw(event: PointerEvent): void {
    const index = cellAt(event);
    if (index < 0) return;
    if (pen === null) pen = alive[index] ? 0 : 1;
    set(index, pen);
  }

  function rebuildSoon(): void {
    const mine = ++resizes;
    if (!columns) {
      build();
      return;
    }
    host.later(180, () => {
      if (mine === resizes) build();
    });
  }

  runButton.addEventListener("click", () => {
    running = !running;
    label();
  });
  $("#life-step", host.body).addEventListener("click", () => {
    running = false;
    step();
  });
  host.onSeed((seed) => {
    random = rng(seed);
    if (!seeded) return;
    running = true;
    scatter();
  });
  $("#life-clear", host.body).addEventListener("click", () => {
    running = false;
    fill(() => 0);
  });

  box.addEventListener("pointerdown", (event) => {
    pen = null;
    draw(event);
  });
  box.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") point(cellAt(event));
    if (pen !== null && event.buttons) draw(event);
  });
  box.addEventListener("pointerleave", () => point(-1));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repaint, {
    signal: host.signal,
  });
  window.addEventListener(
    "pointerup",
    () => {
      pen = null;
    },
    { signal: host.signal },
  );

  new ResizeObserver(rebuildSoon).observe(box);
  host.every(130, () => {
    if (seeded && running && pen === null && host.visible()) step();
  });
  host.frame(fade);
  label();
};

export default toy;
