import "./golf.css";
import { $ } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

type Point = [number, number];
type Rect = [number, number, number, number];
type TrapKind = "sand" | "water" | "ice" | "belt";

interface Trap {
  kind: TrapKind;
  dx: number;
  dy: number;
}

interface Slider {
  x: number;
  y: number;
  dx: number;
  dy: number;
  phase: number;
}

interface Spinner {
  x: number;
  y: number;
  phase: number;
  turn: number;
}

interface Hole {
  tee: Point;
  cup: Point;
  walls: Rect[];
  bumps: Rect[];
  pegs: Point[];
  sliders: Slider[];
  spinners: Spinner[];
  portals: Point[];
  cells: Point[];
  traps: Map<string, Trap>;
}

interface Block {
  className: string;
  rect: Rect;
}

interface Shot {
  angle: number;
  power: number;
}

interface Surface {
  drag: number;
  grip: number;
}

const CELL = 40;
const COLUMNS = 8;
const ROWS = 5;
const BALL_RADIUS = 4;
const MAX_POWER = 480;
const MIN_POWER = 12;
const BOUNCE = 0.8;
const KERB = 4;
const PEG_RADIUS = 6;
const PEG_KICK = 1.15;
const WALL_LONG = 22;
const WALL_THIN = 6;
const SLIDE = 13;
const SPIN_ARM = 15;
const SPIN_WIDTH = 4;
const SPIN_SPEED = 1.8;
const PORTAL_RADIUS = 7;
const SKIM_SPEED = 300;
const NEIGHBOURS: Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const TURF: Surface = { drag: 1.9, grip: 34 };
const SAND: Surface = { drag: 6, grip: 90 };
const ICE: Surface = { drag: 0.25, grip: 5 };

const ARIA_LABEL =
  "Mini golf. Drag back from anywhere on the course and release to hit the ball.";

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <span class="tag" id="golf-hud"></span>
  </div>
  <div class="golf" id="golf" role="application"
    aria-label="${ARIA_LABEL}"><div class="course" id="golf-course"></div></div>`;

const cellId = (x: number, y: number): number => y * COLUMNS + x;
const inside = (x: number, y: number): boolean => x >= 0 && x < COLUMNS && y >= 0 && y < ROWS;
const cellKey = (x: number, y: number): string => `${x},${y}`;
const pick = <T>(random: Rng, list: T[]): T => list[Math.floor(random() * list.length)];

function surfaceOf(kind: TrapKind | undefined): Surface {
  if (kind === "sand") return SAND;
  if (kind === "ice") return ICE;
  return TURF;
}

function wander(random: Rng): Point[] {
  let x = 0;
  let y = Math.floor(random() * ROWS);
  const path: Point[] = [[x, y]];
  const seen = new Set([cellId(x, y)]);
  while (x < COLUMNS - 1) {
    const sides: string[] = [];
    if (y > 0 && !seen.has(cellId(x, y - 1))) sides.push("up");
    if (y < ROWS - 1 && !seen.has(cellId(x, y + 1))) sides.push("down");
    const direction = sides.length && random() < 0.5 ? pick(random, sides) : "right";
    if (direction === "up") y--;
    else if (direction === "down") y++;
    else x++;
    path.push([x, y]);
    seen.add(cellId(x, y));
  }
  return path;
}

function widen(path: Point[], random: Rng, chance: number): Set<number> {
  const fairway = new Set(path.map(([x, y]) => cellId(x, y)));
  for (const [x, y] of path) {
    if (random() >= chance) continue;
    const [dx, dy] = pick(random, NEIGHBOURS);
    const nx = x + dx;
    const ny = y + dy;
    if (inside(nx, ny)) fairway.add(cellId(nx, ny));
  }
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      const near = NEIGHBOURS.filter(
        ([dx, dy]) => inside(x + dx, y + dy) && fairway.has(cellId(x + dx, y + dy)),
      );
      if (near.length >= 2 && random() < chance) fairway.add(cellId(x, y));
    }
  }
  return fairway;
}

function wallsAround(fairway: Set<number>): Rect[] {
  const walls: Rect[] = [];
  for (let y = 0; y < ROWS; y++) {
    let from = -1;
    for (let x = 0; x <= COLUMNS; x++) {
      const open = x < COLUMNS && fairway.has(cellId(x, y));
      if (!open && x < COLUMNS && from < 0) from = x;
      if ((open || x === COLUMNS) && from >= 0) {
        walls.push([from * CELL, y * CELL, (x - from) * CELL, CELL]);
        from = -1;
      }
    }
  }
  return walls;
}

function fairwayCells(fairway: Set<number>): Point[] {
  const cells: Point[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      if (fairway.has(cellId(x, y))) cells.push([x, y]);
    }
  }
  return cells;
}

export function drainPath(
  cells: Point[],
  water: Set<string>,
  from: Point,
  to: Point,
  portals: Point[] = [],
): string[] {
  const open = new Set(cells.map(([x, y]) => cellKey(x, y)));
  const start = cellKey(...from);
  const cost = new Map([[start, 0]]);
  const back = new Map<string, string>();
  const queue: Point[] = [from];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const here = cellKey(x, y);
    const next: Point[] = NEIGHBOURS.map(([dx, dy]) => [x + dx, y + dy]);
    const portal = portals.findIndex(([px, py]) => px === x && py === y);
    if (portal >= 0 && portals.length === 2) next.push(portals[1 - portal]);
    for (const [nx, ny] of next) {
      const key = cellKey(nx, ny);
      if (!open.has(key)) continue;
      const wet = water.has(key) ? 1 : 0;
      const total = cost.get(here)! + wet;
      if (total >= (cost.get(key) ?? Infinity)) continue;
      cost.set(key, total);
      back.set(key, here);
      if (wet) queue.push([nx, ny]);
      else queue.unshift([nx, ny]);
    }
  }
  const drained: string[] = [];
  for (let key = cellKey(...to); key !== start; key = back.get(key)!) {
    if (!back.has(key)) return [];
    if (water.has(key)) drained.push(key);
  }
  return drained;
}

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const area = host.body;
  const stage = $("#golf", area);
  const course = $("#golf-course", area);
  const hud = $("#golf-hud", area);

  const ball = { x: 0, y: 0, vx: 0, vy: 0 };
  const rest = { x: 0, y: 0 };
  let courseWidth = 320;
  let courseHeight = 200;
  let tall = false;
  let seed = 1;
  let level = 0;
  let total = 0;
  let hole: Hole | null = null;
  let solid: Rect[] = [];
  let scale = 1;
  let pull: { x: number; y: number } | null = null;
  let busy = false;
  let pinnedFor = 0;
  let skimmed: string | null = null;
  let portalLock = -1;
  let clock = 0;
  let pegEls: HTMLElement[] = [];
  let sliderEls: HTMLElement[] = [];
  let spinnerEls: HTMLElement[] = [];
  let last = 0;
  let run = 0;
  let ballEl = block("g-ball");
  let aimEl = block("g-aim");

  const turnPoint = (x: number, y: number): Point => (tall ? [y, x] : [x, y]);
  const turnRect = ([x, y, w, h]: Rect): Rect => (tall ? [y, x, h, w] : [x, y, w, h]);
  const moving = (): boolean => ball.vx !== 0 || ball.vy !== 0;

  function generate(n: number): Hole {
    const random = rng(seed + n * 7919);
    const heat = Math.min(1, 0.65 + n * 0.06);
    const path = wander(random);
    const route = new Set(path.map(([x, y]) => cellId(x, y)));
    const fairway = widen(path, random, 0.3 + heat * 0.3);
    const cells = fairwayCells(fairway);
    const bumps: Rect[] = [];
    const pegs: Point[] = [];
    const sliders: Slider[] = [];
    const spinners: Spinner[] = [];
    const ponds = new Map<string, Point>();
    const pond = (x: number, y: number): void => void ponds.set(cellKey(x, y), [x, y]);
    const traps = new Map<string, Trap>();
    const [teeX, teeY] = path[0];
    const [cupX, cupY] = path[path.length - 1];
    const centre = (x: number, y: number): Point => [x * CELL + CELL / 2, y * CELL + CELL / 2];
    const spots = cells.filter(
      ([x, y]) => !(x === teeX && y === teeY) && !(x === cupX && y === cupY),
    );

    let portals: Point[] = [];
    if (n > 0 && spots.length > 5 && random() < 0.3 + n * 0.05) {
      const [ax, ay] = pick(random, spots);
      const far = spots.filter(([x, y]) => Math.abs(x - ax) + Math.abs(y - ay) >= 3);
      if (far.length) portals = [[ax, ay], pick(random, far)];
    }
    const isPortal = (x: number, y: number): boolean =>
      portals.some(([px, py]) => px === x && py === y);

    const trap = (x: number, y: number, kind: TrapKind, dx = 0, dy = 0): void => {
      const turned = tall ? { kind, dx: dy, dy: dx } : { kind, dx, dy };
      traps.set(turnPoint(x, y).join(), turned);
    };
    const corner = (): number => (random() < 0.5 ? 2 : CELL - 12);

    for (const [x, y] of spots) {
      if (isPortal(x, y)) continue;
      const roll = random();
      if (!route.has(cellId(x, y))) {
        if (roll < 0.26 * heat) trap(x, y, "sand");
        else if (roll < 0.5 * heat) pond(x, y);
        else if (roll < 0.64 * heat) trap(x, y, "ice");
        else if (roll < 0.82 * heat) pegs.push(centre(x, y));
        else if (roll < heat) bumps.push([x * CELL + 13, y * CELL + 13, 14, 14]);
      } else if (roll < 0.1 * heat) {
        trap(x, y, "ice");
      } else if (roll < 0.2 * heat) {
        const [dx, dy] = pick(random, NEIGHBOURS);
        trap(x, y, "belt", dx, dy);
      } else if (roll < 0.27 * heat) {
        trap(x, y, "sand");
      } else if (roll < 0.33 * heat && n > 0) {
        pond(x, y);
      } else if (roll < 0.41 * heat && n > 0) {
        const [dx, dy] = pick(random, NEIGHBOURS);
        const [cx, cy] = centre(x, y);
        sliders.push({ x: cx, y: cy, dx: Math.abs(dx), dy: Math.abs(dy), phase: random() * 6 });
      } else if (roll < 0.48 * heat && n > 1) {
        const [cx, cy] = centre(x, y);
        spinners.push({ x: cx, y: cy, phase: random() * 6, turn: random() < 0.5 ? 1 : -1 });
      } else if (roll < 0.53 * heat) {
        pegs.push(centre(x, y));
      } else if (roll < 0.6 * heat) {
        const left = x * CELL + corner();
        const top = y * CELL + corner();
        bumps.push([left, top, 10, 10]);
      }
    }

    const water = new Set(ponds.keys());
    drainPath(cells, water, [teeX, teeY], [cupX, cupY], portals).forEach((key) =>
      ponds.delete(key),
    );
    ponds.forEach(([x, y]) => trap(x, y, "water"));

    return {
      tee: turnPoint(...centre(teeX, teeY)),
      cup: turnPoint(...centre(cupX, cupY)),
      walls: wallsAround(fairway).map(turnRect),
      bumps: bumps.map(turnRect),
      pegs: pegs.map(([x, y]) => turnPoint(x, y)),
      sliders: sliders.map((s) => {
        const [x, y] = turnPoint(s.x, s.y);
        const [dx, dy] = turnPoint(s.dx, s.dy);
        return { x, y, dx, dy, phase: s.phase };
      }),
      spinners: spinners.map((s) => {
        const [x, y] = turnPoint(s.x, s.y);
        return { x, y, phase: s.phase, turn: s.turn };
      }),
      portals: portals.map(([x, y]) => turnPoint(...centre(x, y))),
      cells: cells.map(([x, y]) => turnPoint(x, y)),
      traps,
    };
  }

  function block(className: string, rect?: Rect): HTMLElement {
    const el = document.createElement("div");
    el.className = className;
    if (rect) {
      const [x, y, w, h] = rect;
      el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    }
    course.append(el);
    return el;
  }

  function place(): void {
    ballEl.style.translate = `${ball.x - BALL_RADIUS}px ${ball.y - BALL_RADIUS}px`;
  }

  function paint(): void {
    hud.textContent = `level ${level + 1} · strokes ${total}`;
  }

  function ready(): void {
    const ok = !busy && !moving();
    ballEl.classList.toggle("ready", ok);
    stage.classList.toggle("wait", !ok);
  }

  function stop(): void {
    ball.vx = 0;
    ball.vy = 0;
  }

  function kerbs(cells: Point[]): Block[] {
    const onFairway = new Set(cells.map(([x, y]) => cellKey(x, y)));
    const fair = (x: number, y: number): boolean => onFairway.has(cellKey(x, y));
    const blocks: Block[] = [];
    const kerb = (x: number, y: number, w: number, h: number): void => {
      blocks.push({ className: "g-kerb", rect: [x, y, w, h] });
    };
    for (const [gx, gy] of cells) {
      const x = gx * CELL;
      const y = gy * CELL;
      const up = !fair(gx, gy - 1);
      const down = !fair(gx, gy + 1);
      const left = !fair(gx - 1, gy);
      const right = !fair(gx + 1, gy);
      if (up) kerb(x, y - KERB, CELL, KERB);
      if (down) kerb(x, y + CELL, CELL, KERB);
      if (left) kerb(x - KERB, y, KERB, CELL);
      if (right) kerb(x + CELL, y, KERB, CELL);
      if (up && left) kerb(x - KERB, y - KERB, KERB, KERB);
      if (up && right) kerb(x + CELL, y - KERB, KERB, KERB);
      if (down && left) kerb(x - KERB, y + CELL, KERB, KERB);
      if (down && right) kerb(x + CELL, y + CELL, KERB, KERB);
    }
    return blocks;
  }

  function banks(next: Hole, x: number, y: number): string {
    const shores = NEIGHBOURS.filter(
      ([dx, dy]) => next.traps.get(cellKey(x + dx, y + dy))?.kind !== "water",
    );
    return (
      shores.map(([dx, dy]) => `inset ${-dx * 3}px ${-dy * 3}px 0 var(--g-bank)`).join(", ") ||
      "none"
    );
  }

  function paintTraps(next: Hole): void {
    for (const [x, y] of next.cells) {
      const trap = next.traps.get(cellKey(x, y));
      if (!trap) continue;
      const el = block(`g-${trap.kind}`, [x * CELL, y * CELL, CELL, CELL]);
      if (trap.kind === "belt") {
        el.style.rotate = `${Math.atan2(trap.dy, trap.dx)}rad`;
        continue;
      }
      el.style.setProperty("--ox", `${-x * CELL}px`);
      el.style.setProperty("--oy", `${-y * CELL}px`);
      if (trap.kind === "water") el.style.boxShadow = banks(next, x, y);
    }
  }

  function load(n: number): void {
    const next = generate(n);
    run++;
    level = n;
    hole = next;
    solid = next.walls.concat(next.bumps);
    busy = false;
    pull = null;
    skimmed = null;
    portalLock = -1;
    course.replaceChildren();
    course.style.width = `${courseWidth}px`;
    course.style.height = `${courseHeight}px`;

    next.cells.forEach(([x, y]) => block("g-turf", [x * CELL, y * CELL, CELL, CELL]));
    paintTraps(next);
    block("g-tee", [next.tee[0] - 8, next.tee[1] - 8, 16, 16]);
    const walls = next.bumps.map((rect): Block => ({ className: "g-wall", rect }));
    const raised = walls.concat(kerbs(next.cells));
    raised.forEach(({ rect: [x, y, w, h] }) => block("g-shade", [x, y + 3, w, h]));
    raised.forEach(({ className, rect }) => block(className, rect));
    next.portals.forEach(([x, y], i) => {
      block(`g-portal${i ? " out" : ""}`, [x - 10, y - 10, 20, 20]);
    });
    pegEls = next.pegs.map(([x, y]) => {
      const r = PEG_RADIUS;
      block("g-shade round", [x - r, y - r + 3, r * 2, r * 2]);
      return block("g-peg", [x - r, y - r, r * 2, r * 2]);
    });
    sliderEls = next.sliders.map((s) => {
      const [, , w, h] = sliderAt(s).rect;
      return block("g-slider", [0, 0, w, h]);
    });
    spinnerEls = next.spinners.map(({ x, y }) => {
      const arm = block("g-spinner", [x - SPIN_ARM, y - SPIN_WIDTH / 2, SPIN_ARM * 2, SPIN_WIDTH]);
      block("g-hub", [x - 3, y - 3, 6, 6]);
      return arm;
    });
    moveObstacles();
    block("g-cup", [next.cup[0] - 6.5, next.cup[1] - 6.5, 13, 13]);
    aimEl = block("g-aim");
    aimEl.hidden = true;
    ballEl = block("g-ball");

    ball.x = next.tee[0];
    ball.y = next.tee[1];
    stop();
    place();
    paint();
    ready();
  }

  function shotFrom(from: { x: number; y: number }, event: PointerEvent): Shot {
    const dx = (from.x - event.clientX) / scale;
    const dy = (from.y - event.clientY) / scale;
    return {
      angle: Math.atan2(dy, dx),
      power: Math.min(Math.hypot(dx, dy) * 3.4, MAX_POWER),
    };
  }

  function release(event: PointerEvent): void {
    if (!pull) return;
    const shot = shotFrom(pull, event);
    pull = null;
    aimEl.hidden = true;
    if (event.type !== "pointerup" || shot.power < MIN_POWER || moving()) return;
    rest.x = ball.x;
    rest.y = ball.y;
    ball.vx = Math.cos(shot.angle) * shot.power;
    ball.vy = Math.sin(shot.angle) * shot.power;
    total++;
    paint();
    ready();
  }

  function ripple(big: boolean): void {
    const size = big ? 30 : 18;
    const el = block(`g-ripple${big ? " big" : ""}`, [
      ball.x - size / 2,
      ball.y - size / 2,
      size,
      size,
    ]);
    host.later(900, () => el.remove());
  }

  function drop(then: () => void, sunk = false): void {
    const mine = run;
    busy = true;
    stop();
    place();
    ballEl.classList.add("gone");
    ballEl.classList.toggle("sunk", sunk);
    ready();
    host.later(520, () => {
      if (mine === run) then();
    });
  }

  function backFromWater(): void {
    ball.x = rest.x;
    ball.y = rest.y;
    total++;
    busy = false;
    ballEl.classList.remove("gone", "sunk");
    place();
    paint();
    ready();
  }

  function bounceOffEdges(): void {
    const right = courseWidth - BALL_RADIUS;
    const bottom = courseHeight - BALL_RADIUS;
    if (ball.x < BALL_RADIUS) {
      ball.x = BALL_RADIUS;
      ball.vx = Math.abs(ball.vx) * BOUNCE;
    }
    if (ball.x > right) {
      ball.x = right;
      ball.vx = -Math.abs(ball.vx) * BOUNCE;
    }
    if (ball.y < BALL_RADIUS) {
      ball.y = BALL_RADIUS;
      ball.vy = Math.abs(ball.vy) * BOUNCE;
    }
    if (ball.y > bottom) {
      ball.y = bottom;
      ball.vy = -Math.abs(ball.vy) * BOUNCE;
    }
  }

  function bounceOffSolid([x, y, w, h]: Rect): boolean {
    const left = ball.x - (x - BALL_RADIUS);
    const right = x + w + BALL_RADIUS - ball.x;
    const top = ball.y - (y - BALL_RADIUS);
    const bottom = y + h + BALL_RADIUS - ball.y;
    if (left <= 0 || right <= 0 || top <= 0 || bottom <= 0) return false;
    const nearest = Math.min(left, right, top, bottom);
    if (nearest === left) {
      ball.x = x - BALL_RADIUS;
      ball.vx = -Math.abs(ball.vx) * BOUNCE;
    } else if (nearest === right) {
      ball.x = x + w + BALL_RADIUS;
      ball.vx = Math.abs(ball.vx) * BOUNCE;
    } else if (nearest === top) {
      ball.y = y - BALL_RADIUS;
      ball.vy = -Math.abs(ball.vy) * BOUNCE;
    } else {
      ball.y = y + h + BALL_RADIUS;
      ball.vy = Math.abs(ball.vy) * BOUNCE;
    }
    return true;
  }

  function sliderAt(s: Slider): { rect: Rect; vx: number; vy: number } {
    const offset = Math.sin(clock * 1.6 + s.phase) * SLIDE;
    const speed = Math.cos(clock * 1.6 + s.phase) * SLIDE * 1.6;
    const w = s.dx ? WALL_THIN : WALL_LONG;
    const h = s.dx ? WALL_LONG : WALL_THIN;
    return {
      rect: [s.x + s.dx * offset - w / 2, s.y + s.dy * offset - h / 2, w, h],
      vx: s.dx * speed,
      vy: s.dy * speed,
    };
  }

  const spinAngle = (s: Spinner): number => s.phase + clock * SPIN_SPEED * s.turn;

  function moveObstacles(): void {
    hole?.sliders.forEach((s, i) => {
      const [x, y] = sliderAt(s).rect;
      sliderEls[i].style.translate = `${x}px ${y}px`;
    });
    hole?.spinners.forEach((s, i) => {
      spinnerEls[i].style.rotate = `${spinAngle(s)}rad`;
    });
  }

  function sweepBySpinner(s: Spinner): void {
    const angle = spinAngle(s);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const along = Math.max(-SPIN_ARM, Math.min(SPIN_ARM, (ball.x - s.x) * ux + (ball.y - s.y) * uy));
    const dx = ball.x - (s.x + ux * along);
    const dy = ball.y - (s.y + uy * along);
    const distance = Math.hypot(dx, dy);
    const reach = BALL_RADIUS + SPIN_WIDTH / 2;
    if (distance >= reach) return;
    const nx = distance ? dx / distance : -uy;
    const ny = distance ? dy / distance : ux;
    ball.x += nx * (reach - distance);
    ball.y += ny * (reach - distance);
    const spin = SPIN_SPEED * s.turn * along;
    const sx = -uy * spin;
    const sy = ux * spin;
    const into = (ball.vx - sx) * nx + (ball.vy - sy) * ny;
    if (into >= 0) return;
    ball.vx -= (1 + BOUNCE) * into * nx;
    ball.vy -= (1 + BOUNCE) * into * ny;
  }

  function pushByMovers(): void {
    for (const s of hole?.sliders ?? []) {
      const { rect, vx, vy } = sliderAt(s);
      if (!bounceOffSolid(rect)) continue;
      ball.vx += vx * 2;
      ball.vy += vy * 2;
    }
    hole?.spinners.forEach(sweepBySpinner);
  }

  function bounceOffPegs(): void {
    hole?.pegs.forEach(([x, y], i) => {
      const dx = ball.x - x;
      const dy = ball.y - y;
      const distance = Math.hypot(dx, dy);
      const reach = PEG_RADIUS + BALL_RADIUS;
      if (distance >= reach || distance === 0) return;
      const nx = dx / distance;
      const ny = dy / distance;
      ball.x = x + nx * reach;
      ball.y = y + ny * reach;
      const into = ball.vx * nx + ball.vy * ny;
      if (into >= 0) return;
      ball.vx = (ball.vx - 2 * into * nx) * PEG_KICK;
      ball.vy = (ball.vy - 2 * into * ny) * PEG_KICK;
      const el = pegEls[i];
      el.classList.remove("hit");
      void el.offsetWidth;
      el.classList.add("hit");
    });
  }

  function throughPortals(): void {
    const portals = hole?.portals ?? [];
    portals.forEach(([x, y], i) => {
      const near = Math.hypot(ball.x - x, ball.y - y) < PORTAL_RADIUS;
      if (i === portalLock) {
        if (!near) portalLock = -1;
        return;
      }
      if (!near || portalLock >= 0) return;
      const exit = 1 - i;
      [ball.x, ball.y] = portals[exit];
      portalLock = exit;
      place();
    });
  }

  function step(dt: number): void {
    if (!hole) return;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    bounceOffEdges();
    solid.forEach(bounceOffSolid);
    pushByMovers();
    bounceOffPegs();
    throughPortals();

    const under = cellKey(Math.floor(ball.x / CELL), Math.floor(ball.y / CELL));
    const trap = hole.traps.get(under);
    if (trap?.kind === "water") {
      const speed = Math.hypot(ball.vx, ball.vy);
      if (under !== skimmed && speed > SKIM_SPEED) {
        skimmed = under;
        ball.vx *= 0.6;
        ball.vy *= 0.6;
        ripple(false);
      } else if (under !== skimmed || speed < SKIM_SPEED / 3) {
        ripple(true);
        drop(backFromWater, true);
        return;
      }
    } else {
      skimmed = null;
    }
    if (trap?.kind === "belt") {
      ball.vx += trap.dx * 300 * dt;
      ball.vy += trap.dy * 300 * dt;
    }
    pinnedFor = trap?.kind === "belt" && Math.hypot(ball.vx, ball.vy) < 30 ? pinnedFor + dt : 0;
    if (pinnedFor > 0.5) {
      pinnedFor = 0;
      stop();
      return;
    }

    const [cupX, cupY] = hole.cup;
    const toCupX = cupX - ball.x;
    const toCupY = cupY - ball.y;
    const cupDistance = Math.hypot(toCupX, toCupY);
    if (cupDistance < 11 && cupDistance > 0.01) {
      ball.vx += (toCupX / cupDistance) * 520 * dt;
      ball.vy += (toCupY / cupDistance) * 520 * dt;
    }

    const surface = surfaceOf(trap?.kind);
    const drag = 1 - surface.drag * dt;
    ball.vx *= drag;
    ball.vy *= drag;
    let speed = Math.hypot(ball.vx, ball.vy);
    if (speed > 0) {
      const slowed = Math.max(0, speed - surface.grip * dt);
      ball.vx *= slowed / speed;
      ball.vy *= slowed / speed;
      speed = slowed;
    }

    if (cupDistance < 5 && speed < 230) {
      ball.x = cupX;
      ball.y = cupY;
      drop(() => load(level + 1));
      return;
    }
    if (speed < 7 && trap?.kind !== "belt" && cupDistance >= 11) stop();
  }

  function tick(time: number): void {
    const dt = Math.min(0.033, (time - last) / 1000 || 0);
    last = time;
    clock += dt;
    moveObstacles();
    if (!busy && !moving()) {
      pushByMovers();
      if (moving()) ready();
    }
    if (busy || !moving()) return;
    for (let i = 0; i < 4 && !busy; i++) step(dt / 4);
    if (busy) return;
    place();
    if (!moving()) ready();
  }

  function resize(): void {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width) return;
    const turn = height > width * 1.1;
    if (turn !== tall) {
      tall = turn;
      courseWidth = tall ? 200 : 320;
      courseHeight = tall ? 320 : 200;
      if (hole) load(level);
    }
    scale = Math.min(width / (courseWidth + 28), height / (courseHeight + 28));
    const left = (width - courseWidth * scale) / 2;
    const top = (height - courseHeight * scale) / 2;
    course.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  }

  area.addEventListener("pointerdown", (event) => {
    const onButton = event.target instanceof Element && event.target.closest("button");
    if (moving() || busy || onButton) return;
    pull = { x: event.clientX, y: event.clientY };
    try {
      area.setPointerCapture(event.pointerId);
    } catch {}
  });

  area.addEventListener("pointermove", (event) => {
    if (!pull) return;
    const shot = shotFrom(pull, event);
    aimEl.hidden = shot.power < MIN_POWER;
    aimEl.style.width = `${(shot.power / MAX_POWER) * 90}px`;
    aimEl.style.transform =
      `translate(${ball.x}px, ${ball.y - 1.5}px) rotate(${shot.angle}rad)`;
  });

  area.addEventListener("pointerup", release);
  area.addEventListener("pointercancel", release);

  new ResizeObserver(resize).observe(stage);
  host.onSeed((next) => {
    seed = next;
    total = 0;
    load(0);
  });
  host.frame(tick);
};

export default toy;
