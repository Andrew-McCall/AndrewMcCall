import "./mines.css";
import { $, clamp } from "../dom";
import { rng, type Toy } from "../toy";

interface Cell {
  el: HTMLButtonElement;
  mine: boolean;
  nearby: number;
  open: boolean;
  flag: boolean;
}

const CELL_PX = 34;
const MIN_ROOM_PX = 60;
const MINE_SHARE = 0.15;
const DIG_DELAY_MS = 22;
const FINISH_DELAY_MS = 30;

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <button class="btn" id="mines-flag" type="button" aria-pressed="false">Flag</button>
    <span class="tag" id="mines-hud"></span>
  </div>
  <div class="mines-wrap"><div class="mines" id="mines"></div></div>
`;

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const grid = $("#mines", host.body);
  const wrap = $(".mines-wrap", host.body);
  const hud = $("#mines-hud", host.body);
  const flagButton = $("#mines-flag", host.body);
  const indexes = new WeakMap<EventTarget, number>();

  let cols = 12;
  let rows = 9;
  let mines = 16;
  let seed = 1;
  let cells: Cell[] = [];
  let placed = false;
  let over = false;
  let won = false;
  let flags = 0;
  let left = 0;
  let started = 0;
  let elapsed = 0;
  let clock = 0;
  let flagging = false;

  const near = (index: number): number[] => {
    const x = index % cols;
    const y = (index - x) / cols;
    const around: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        const inside = nx >= 0 && ny >= 0 && nx < cols && ny < rows;
        if ((dx || dy) && inside) around.push(ny * cols + nx);
      }
    }
    return around;
  };

  const far = (a: number, b: number): number =>
    Math.hypot((a % cols) - (b % cols), Math.floor(a / cols) - Math.floor(b / cols));

  const room = (): [number, number] => {
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (width < MIN_ROOM_PX) return [cols, rows];
    return [
      clamp(Math.round(width / CELL_PX), 8, 26),
      clamp(Math.round(height / CELL_PX), 6, 18),
    ];
  };

  const hudText = (): string => {
    if (over) return won ? `Cleared in ${Math.floor(elapsed / 1000)}s` : "Boom";
    const seconds = placed ? Math.floor((Date.now() - started) / 1000) : 0;
    return `${mines - flags} mines · ${seconds}s`;
  };

  const paint = (): void => {
    hud.textContent = hudText();
    flagButton.setAttribute("aria-pressed", String(flagging));
  };

  const startClock = (): void => {
    const me = ++clock;
    host.every(1000, () => {
      if (me === clock) paint();
    });
  };

  const stopClock = (): void => {
    clock++;
  };

  const addCell = (index: number): void => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "m";
    el.setAttribute("aria-label", "Hidden square");
    indexes.set(el, index);
    cells.push({ el, mine: false, nearby: 0, open: false, flag: false });
    grid.append(el);
  };

  const reset = (next: number): void => {
    seed = next;
    stopClock();
    [cols, rows] = room();
    mines = Math.round(cols * rows * MINE_SHARE);
    grid.style.setProperty("--cols", String(cols));
    grid.style.setProperty("--rows", String(rows));
    placed = false;
    over = false;
    won = false;
    flags = 0;
    left = cols * rows - mines;
    grid.className = "mines";
    grid.replaceChildren();
    cells = [];
    for (let i = 0; i < cols * rows; i++) addCell(i);
    paint();
  };

  const lay = (safe: number): void => {
    const random = rng(seed);
    const order = cells.map((_, i) => i);
    const banned = new Set([safe, ...near(safe)]);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let laid = 0;
    for (const index of order) {
      if (laid === mines) break;
      if (banned.has(index)) continue;
      cells[index].mine = true;
      laid++;
    }
    cells.forEach((cell, index) => {
      cell.nearby = near(index).filter((other) => cells[other].mine).length;
    });
    placed = true;
    started = Date.now();
    startClock();
  };

  const dig = (index: number, from: number): void => {
    const cell = cells[index];
    if (cell.open || cell.flag) return;
    cell.open = true;
    left--;
    cell.el.style.transitionDelay = `${far(index, from) * DIG_DELAY_MS}ms`;
    cell.el.classList.add("open");
    if (cell.nearby) {
      cell.el.textContent = String(cell.nearby);
      cell.el.setAttribute("aria-label", `${cell.nearby} nearby`);
    } else {
      cell.el.setAttribute("aria-label", "Empty");
      for (const other of near(index)) dig(other, from);
    }
  };

  const mark = (cell: Cell): void => {
    if (cell.open) return;
    cell.flag = !cell.flag;
    flags += cell.flag ? 1 : -1;
    cell.el.classList.toggle("flag", cell.flag);
  };

  const finish = (win: boolean, at: number): void => {
    over = true;
    won = win;
    stopClock();
    elapsed = Date.now() - started;
    cells.forEach((cell, index) => {
      if (!cell.mine) return;
      cell.el.style.transitionDelay = `${far(index, at) * FINISH_DELAY_MS}ms`;
      cell.el.classList.add(win ? "flag" : "boom");
    });
    grid.classList.add(win ? "won" : "shake");
  };

  const open = (index: number): void => {
    const cell = cells[index];
    if (cell.flag || cell.open) return;
    if (!placed) lay(index);
    if (cell.mine) {
      finish(false, index);
      return;
    }
    dig(index, index);
    if (!left) finish(true, index);
  };

  const act = (target: EventTarget | null, flag: boolean): void => {
    const index = target ? indexes.get(target) : undefined;
    if (index === undefined || over) return;
    if (flag) mark(cells[index]);
    else open(index);
    paint();
  };

  grid.addEventListener("click", (event) => act(event.target, flagging));
  grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    act(event.target, true);
  });
  flagButton.addEventListener("click", () => {
    flagging = !flagging;
    paint();
  });

  new ResizeObserver(() => {
    const [roomCols, roomRows] = room();
    if (!placed && (roomCols !== cols || roomRows !== rows)) reset(seed);
  }).observe(wrap);

  host.onSeed(reset);
};

export default toy;
