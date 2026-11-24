import "./life.css";
import { $, calm } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

const PITCH = 13;
const MAX_COLUMNS = 80;
const MAX_ROWS = 60;
const MIN_SIDE = 4;
const SETTLED_AFTER = 3;

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" id="life-run" type="button">Pause</button>
    <button class="btn" id="life-step" type="button">Step</button>
    <button class="btn" id="life-rand" type="button" data-restart>Restart</button>
    <button class="btn" id="life-clear" type="button">Clear</button>
    <span class="tag" id="life-gen">gen 0</span>
  </div>
  <div class="life field" id="life" role="img"
    aria-label="Game of Life grid. Click or drag to draw cells.">
    <div class="life-grid" id="life-grid"></div>
  </div>`;

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const box = $("#life", host.body);
  const grid = $("#life-grid", host.body);
  const runButton = $("#life-run", host.body);
  const generationLabel = $("#life-gen", host.body);

  let columns = 0;
  let rows = 0;
  let alive: Uint8Array = new Uint8Array(0);
  let cells: HTMLElement[] = [];
  let indexOfCell = new Map<Element, number>();
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

  function set(index: number, value: number): void {
    if (alive[index] === value) return;
    alive[index] = value;
    cells[index].className = value ? "on" : "";
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
    const newColumns = Math.min(MAX_COLUMNS, Math.floor((box.clientWidth + 1) / PITCH));
    const newRows = Math.min(MAX_ROWS, Math.floor((box.clientHeight + 1) / PITCH));
    if (newColumns < MIN_SIDE || newRows < MIN_SIDE) return;
    if (newColumns === columns && newRows === rows) return;
    const first = !columns;
    alive = resized(newColumns, newRows);
    columns = newColumns;
    rows = newRows;
    cells = [];
    indexOfCell = new Map();
    for (let i = 0; i < alive.length; i++) {
      const cell = document.createElement("i");
      if (alive[i]) cell.className = "on";
      cells.push(cell);
      indexOfCell.set(cell, i);
    }
    grid.style.gridTemplateColumns = `repeat(${columns}, 12px)`;
    grid.replaceChildren(...cells);
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

  function draw(event: PointerEvent): void {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const index = target ? indexOfCell.get(target) : undefined;
    if (index === undefined) return;
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
    if (pen !== null && event.buttons) draw(event);
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
  label();
};

export default toy;
