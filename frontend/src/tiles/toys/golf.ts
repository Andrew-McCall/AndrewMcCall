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

interface Hole {
  tee: Point;
  cup: Point;
  walls: Rect[];
  bumps: Rect[];
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

function widen(path: Point[], random: Rng): Set<number> {
  const fairway = new Set(path.map(([x, y]) => cellId(x, y)));
  for (const [x, y] of path) {
    if (random() >= 0.38) continue;
    const [dx, dy] = pick(random, NEIGHBOURS);
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < COLUMNS && ny >= 0 && ny < ROWS) fairway.add(cellId(nx, ny));
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
  let last = 0;
  let run = 0;
  let ballEl = block("g-ball");
  let aimEl = block("g-aim");

  const turnPoint = (x: number, y: number): Point => (tall ? [y, x] : [x, y]);
  const turnRect = ([x, y, w, h]: Rect): Rect => (tall ? [y, x, h, w] : [x, y, w, h]);
  const moving = (): boolean => ball.vx !== 0 || ball.vy !== 0;

  function generate(n: number): Hole {
    const random = rng(seed + n * 7919);
    const heat = Math.min(1, 0.55 + n * 0.05);
    const path = wander(random);
    const route = new Set(path.map(([x, y]) => cellId(x, y)));
    const fairway = widen(path, random);
    const cells = fairwayCells(fairway);
    const bumps: Rect[] = [];
    const traps = new Map<string, Trap>();
    const [teeX, teeY] = path[0];
    const [cupX, cupY] = path[path.length - 1];

    const trap = (x: number, y: number, kind: TrapKind, dx = 0, dy = 0): void => {
      const turned = tall ? { kind, dx: dy, dy: dx } : { kind, dx, dy };
      traps.set(turnPoint(x, y).join(), turned);
    };
    const corner = (): number => (random() < 0.5 ? 2 : CELL - 12);

    for (const [x, y] of cells) {
      if ((x === teeX && y === teeY) || (x === cupX && y === cupY)) continue;
      const roll = random();
      if (!route.has(cellId(x, y))) {
        if (roll < 0.34 * heat) trap(x, y, "sand");
        else if (roll < 0.62 * heat) trap(x, y, "water");
        else if (roll < 0.8 * heat) trap(x, y, "ice");
        else if (roll < heat) bumps.push([x * CELL + 13, y * CELL + 13, 14, 14]);
      } else if (roll < 0.12 * heat) {
        trap(x, y, "ice");
      } else if (roll < 0.24 * heat) {
        const [dx, dy] = pick(random, NEIGHBOURS);
        trap(x, y, "belt", dx, dy);
      } else if (roll < 0.32 * heat) {
        trap(x, y, "sand");
      } else if (roll < 0.46 * heat) {
        const left = x * CELL + corner();
        const top = y * CELL + corner();
        bumps.push([left, top, 10, 10]);
      }
    }

    return {
      tee: turnPoint(teeX * CELL + CELL / 2, teeY * CELL + CELL / 2),
      cup: turnPoint(cupX * CELL + CELL / 2, cupY * CELL + CELL / 2),
      walls: wallsAround(fairway).map(turnRect),
      bumps: bumps.map(turnRect),
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

  function paintTraps(next: Hole): void {
    for (const [x, y] of next.cells) {
      const trap = next.traps.get(cellKey(x, y));
      if (!trap) continue;
      const el = block(`g-${trap.kind}`, [x * CELL, y * CELL, CELL, CELL]);
      if (trap.kind === "belt") el.style.rotate = `${Math.atan2(trap.dy, trap.dx)}rad`;
      else el.style.backgroundPosition = `${-x * CELL}px ${-y * CELL}px`;
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
    if (event.type !== "pointerup" || shot.power < MIN_POWER) return;
    rest.x = ball.x;
    rest.y = ball.y;
    ball.vx = Math.cos(shot.angle) * shot.power;
    ball.vy = Math.sin(shot.angle) * shot.power;
    total++;
    paint();
    ready();
  }

  function drop(then: () => void): void {
    const mine = run;
    busy = true;
    stop();
    place();
    ballEl.classList.add("gone");
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
    ballEl.classList.remove("gone");
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

  function bounceOffSolid([x, y, w, h]: Rect): void {
    const left = ball.x - (x - BALL_RADIUS);
    const right = x + w + BALL_RADIUS - ball.x;
    const top = ball.y - (y - BALL_RADIUS);
    const bottom = y + h + BALL_RADIUS - ball.y;
    if (left <= 0 || right <= 0 || top <= 0 || bottom <= 0) return;
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
  }

  function step(dt: number): void {
    if (!hole) return;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    bounceOffEdges();
    solid.forEach(bounceOffSolid);

    const under = cellKey(Math.floor(ball.x / CELL), Math.floor(ball.y / CELL));
    const trap = hole.traps.get(under);
    if (trap?.kind === "water") {
      drop(backFromWater);
      return;
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
