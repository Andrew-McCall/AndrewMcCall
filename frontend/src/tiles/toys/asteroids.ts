import "./asteroids.css";
import { $, $$, calm } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

type State = "idle" | "play" | "pause" | "over";

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  el: HTMLElement;
}

interface Rock extends Body {
  spin: number;
  size: number;
  tint: string;
}

interface Spark extends Body {
  life: number;
}

const CELLS = [0, 5, 8, 12];
const PX = 4;
const RADIUS = CELLS.map((cells) => cells * PX * 0.44);
const POINTS = [0, 100, 50, 20];
const BEST_KEY = "am-rocks-best";
const FULL_TURN = 6.283;
const SHIP_HALF_WIDTH = 11;
const SHIP_HALF_HEIGHT = 9;

const TINTS = [
  "var(--w-projects)",
  "var(--w-now)",
  "var(--w-posts)",
  "var(--w-life)",
  "var(--w-about)",
  "var(--w-contact)",
];

const KEYMAP = new Map([
  ["a", "ArrowLeft"],
  ["d", "ArrowRight"],
  ["w", "ArrowUp"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["arrowup", "ArrowUp"],
  [" ", " "],
]);
const ALSO_MINE = new Set(["s", "arrowdown", "p"]);

const SHIP = [
  "ebb........",
  "ebbbbb.....",
  "ebbbbbbbb..",
  "ebbwwbbbbbb",
  "ebbwwwbbbbb",
  "ebbwwbbbbbb",
  "ebbbbbbbb..",
  "ebbbbb.....",
  "ebb........",
];

const SHIP_PALETTE = {
  b: "var(--w)",
  w: "var(--paper)",
  e: "color-mix(in oklch, var(--w) 50%, var(--on-win))",
};

const MESSAGES: Record<State, string> = {
  idle: "Click to play. WASD or arrows fly, space fires",
  pause: "Paused. Click to carry on",
  over: "Game over. Space to go again",
  play: "",
};

const ARIA_LABEL =
  "Asteroids, a small space shooter. Click to play. " +
  "Arrow keys turn and thrust, space fires, P pauses.";

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <span class="tag" id="rocks-hud">score 0 · lives 3 · best 0</span>
  </div>
  <div class="rocks" id="rocks" tabindex="0" role="application"
    aria-label="${ARIA_LABEL}"><div class="rocks-msg" id="rocks-msg"></div></div>
  <div class="pad">
    <button class="btn" type="button" data-k="ArrowLeft">Left</button>
    <button class="btn" type="button" data-k="ArrowUp">Thrust</button>
    <button class="btn" type="button" data-k="ArrowRight">Right</button>
    <button class="btn" type="button" data-k=" ">Fire</button>
  </div>`;

function sprite(
  rows: string[],
  px: number,
  palette: Record<string, string>,
): HTMLElement {
  const el = document.createElement("i");
  const shadows: string[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const colour = palette[cell];
      if (colour) shadows.push(`${(x + 1) * px}px ${(y + 1) * px}px 0 ${colour}`);
    });
  });
  el.style.cssText =
    `position:absolute;left:${-px}px;top:${-px}px;width:${px}px;height:${px}px;` +
    `box-shadow:${shadows.join(",")}`;
  return el;
}

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeBest(best: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {}
}

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const stage = $("#rocks", host.body);
  const msg = $("#rocks-msg", host.body);
  const hud = $("#rocks-hud", host.body);
  const reduced = calm();

  const held = new Set<string>();
  const rocks: Rock[] = [];
  const shots: Spark[] = [];
  const bits: Spark[] = [];

  let random: Rng = Math.random;
  let seed = 1;
  let width = 0;
  let height = 0;
  let seeded = false;
  let wanted = false;
  let state: State = "idle";
  let score = 0;
  let lives = 3;
  let wave = 0;
  let best = readBest();
  let last = 0;
  let cool = 0;
  let safe = 0;
  let pointer = false;
  let leaving = false;

  function add(className: string, w: number, h: number): HTMLElement {
    const el = document.createElement("div");
    el.className = className;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    stage.append(el);
    return el;
  }

  const stars = add("stars", 1, 1);
  const ship: Body = { x: 0, y: 0, vx: 0, vy: 0, a: -Math.PI / 2, el: add("ship", 22, 18) };
  const flame = document.createElement("b");
  flame.className = "flame";
  ship.el.append(sprite(SHIP, 2, SHIP_PALETTE), flame);

  function put(body: Body, halfWidth: number, halfHeight: number): void {
    const x = body.x - halfWidth;
    const y = body.y - halfHeight;
    body.el.style.transform = `translate(${x}px, ${y}px) rotate(${body.a}rad)`;
  }

  function putShip(): void {
    put(ship, SHIP_HALF_WIDTH, SHIP_HALF_HEIGHT);
  }

  function putRock(rock: Rock): void {
    const half = (CELLS[rock.size] * PX) / 2;
    put(rock, half, half);
  }

  function wrap(body: Body): void {
    body.x = ((body.x % width) + width) % width;
    body.y = ((body.y % height) + height) % height;
  }

  function rockRows(cells: number): string[] {
    const lobes = Array.from({ length: 8 }, () => 0.68 + random() * 0.32);
    const mid = (cells - 1) / 2;

    const inside = (x: number, y: number): boolean => {
      const dx = x - mid;
      const dy = y - mid;
      const turn = ((Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1) * 8;
      const lobe = Math.floor(turn);
      const blend = turn - lobe;
      const reach = lobes[lobe] * (1 - blend) + lobes[(lobe + 1) % 8] * blend;
      return Math.hypot(dx, dy) / (cells / 2) <= reach;
    };

    const grid: boolean[][] = [];
    for (let y = 0; y < cells; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < cells; x++) row.push(inside(x, y));
      grid.push(row);
    }

    const shade = (x: number, y: number): string => {
      if (!grid[y][x]) return ".";
      const lit = (x + y) / (2 * cells - 2);
      const edge = !grid[y + 1]?.[x] || !grid[y][x + 1];
      if (lit < 0.34) return "h";
      return lit > 0.62 || edge || random() < 0.07 ? "l" : "m";
    };

    return grid.map((row, y) => row.map((_, x) => shade(x, y)).join(""));
  }

  function rockArt(cells: number, tint: string): HTMLElement {
    return sprite(rockRows(cells), PX, {
      m: tint,
      h: `color-mix(in oklch, ${tint} 58%, var(--paper))`,
      l: `color-mix(in oklch, ${tint} 58%, var(--on-win))`,
    });
  }

  function addRock(x: number, y: number, size: number): void {
    const direction = random() * FULL_TURN;
    const speed = (30 + random() * 45) * (4 - size) * 0.7;
    const cells = CELLS[size];
    const tint = TINTS[Math.floor(random() * TINTS.length)];
    const el = add("rock", cells * PX, cells * PX);
    el.append(rockArt(cells, tint));
    const a = random() * 6;
    const spin = (random() - 0.5) * 1.6;
    const rock: Rock = {
      x,
      y,
      vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed,
      a,
      spin,
      size,
      tint,
      el,
    };
    rocks.push(rock);
    putRock(rock);
  }

  function field(count: number): void {
    const clearance = Math.min(width, height) * 0.3;
    for (let i = 0; i < count; i++) {
      let x: number;
      let y: number;
      do {
        x = random() * width;
        y = random() * height;
      } while (Math.hypot(x - ship.x, y - ship.y) < clearance);
      addRock(x, y, 3);
    }
  }

  function burst(x: number, y: number, tint: string, count: number): void {
    if (reduced) return;
    for (let i = 0; i < count; i++) {
      const direction = Math.random() * FULL_TURN;
      const speed = 40 + Math.random() * 130;
      const el = add("bit", 3, 3);
      el.style.background = tint;
      const bit: Spark = {
        x,
        y,
        vx: Math.cos(direction) * speed,
        vy: Math.sin(direction) * speed,
        a: 0,
        life: 0.3 + Math.random() * 0.35,
        el,
      };
      bits.push(bit);
      put(bit, 1.5, 1.5);
    }
  }

  function clear(list: Body[]): void {
    list.forEach((body) => body.el.remove());
    list.length = 0;
  }

  function clearAll(): void {
    clear(rocks);
    clear(shots);
    clear(bits);
  }

  function centre(): void {
    ship.x = width / 2;
    ship.y = height / 2;
    ship.vx = 0;
    ship.vy = 0;
    ship.a = -Math.PI / 2;
  }

  function paint(): void {
    hud.textContent = `score ${score} · lives ${lives} · best ${best}`;
    msg.textContent = MESSAGES[state];
    ship.el.hidden = state === "over" || !seeded;
  }

  function start(): void {
    if (!width) {
      wanted = true;
      return;
    }
    wanted = false;
    clearAll();
    random = rng(seed);
    score = 0;
    lives = 3;
    wave = 0;
    safe = 2;
    centre();
    field(4);
    state = "play";
    paint();
  }

  function fire(): void {
    const cos = Math.cos(ship.a);
    const sin = Math.sin(ship.a);
    const shot: Spark = {
      x: ship.x + cos * 13,
      y: ship.y + sin * 13,
      vx: ship.vx + cos * 430,
      vy: ship.vy + sin * 430,
      a: ship.a,
      life: 0.95,
      el: add("shot", 6, 2),
    };
    shots.push(shot);
    put(shot, 3, 1);
  }

  function fly(dt: number): void {
    if (held.has("ArrowLeft")) ship.a -= 3.8 * dt;
    if (held.has("ArrowRight")) ship.a += 3.8 * dt;
    const burn = held.has("ArrowUp");
    if (burn) {
      ship.vx += Math.cos(ship.a) * 260 * dt;
      ship.vy += Math.sin(ship.a) * 260 * dt;
    }
    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > 340) {
      ship.vx *= 340 / speed;
      ship.vy *= 340 / speed;
    }
    ship.vx *= 1 - 0.4 * dt;
    ship.vy *= 1 - 0.4 * dt;
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
    wrap(ship);
    cool -= dt;
    safe -= dt;
    ship.el.classList.toggle("burn", burn);
    ship.el.classList.toggle("safe", safe > 0);
    if (held.has(" ") && cool <= 0 && shots.length < 6) {
      cool = 0.2;
      fire();
    }
  }

  function moveRocks(dt: number): void {
    for (const rock of rocks) {
      rock.x += rock.vx * dt;
      rock.y += rock.vy * dt;
      rock.a += rock.spin * dt;
      wrap(rock);
      putRock(rock);
    }
  }

  function moveBits(dt: number): void {
    for (let i = bits.length - 1; i >= 0; i--) {
      const bit = bits[i];
      bit.x += bit.vx * dt;
      bit.y += bit.vy * dt;
      bit.life -= dt;
      if (bit.life <= 0) {
        bit.el.remove();
        bits.splice(i, 1);
        continue;
      }
      bit.el.style.opacity = String(Math.min(1, bit.life * 3));
      put(bit, 1.5, 1.5);
    }
  }

  function breakRock(index: number): void {
    const rock = rocks[index];
    rock.el.remove();
    rocks.splice(index, 1);
    burst(rock.x, rock.y, rock.tint, 4 + rock.size * 3);
    score += POINTS[rock.size];
    if (rock.size > 1) {
      addRock(rock.x, rock.y, rock.size - 1);
      addRock(rock.x, rock.y, rock.size - 1);
    }
    paint();
  }

  function moveShots(dt: number): void {
    for (let i = shots.length - 1; i >= 0; i--) {
      const shot = shots[i];
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.life -= dt;
      wrap(shot);
      put(shot, 3, 1);
      const hit = rocks.findIndex(
        (rock) => Math.hypot(rock.x - shot.x, rock.y - shot.y) < RADIUS[rock.size] + 3,
      );
      if (shot.life <= 0 || hit >= 0) {
        shot.el.remove();
        shots.splice(i, 1);
      }
      if (hit >= 0) breakRock(hit);
    }
  }

  function shipStruck(): boolean {
    return rocks.some(
      (rock) => Math.hypot(rock.x - ship.x, rock.y - ship.y) < RADIUS[rock.size] + 7,
    );
  }

  function loseLife(): void {
    burst(ship.x, ship.y, "var(--paper)", 16);
    lives--;
    if (lives <= 0) {
      state = "over";
      if (score > best) {
        best = score;
        writeBest(best);
      }
    } else {
      centre();
      safe = 2;
    }
    paint();
  }

  function nextWave(): void {
    wave++;
    field(4 + wave);
    safe = Math.max(safe, 1);
  }

  function tick(time: number): void {
    const dt = Math.min(0.033, (time - last) / 1000 || 0);
    last = time;
    if (!width || state === "pause") return;
    const playing = state === "play";
    if (playing) fly(dt);
    else if (reduced) return;
    moveRocks(dt);
    moveBits(dt);
    moveShots(dt);
    if (playing) {
      if (safe <= 0 && shipStruck()) loseLife();
      if (!rocks.length) nextWave();
    }
    putShip();
  }

  function togglePause(): void {
    state = state === "play" ? "pause" : "play";
    paint();
  }

  function layStars(): void {
    const starRandom = rng(seed + 99);
    const dots: string[] = [];
    for (let i = 0; i < 70; i++) {
      const x = Math.floor(starRandom() * width);
      const y = Math.floor(starRandom() * height);
      const spread = starRandom() < 0.25 ? 0.5 : 0;
      const strength = 20 + Math.floor(starRandom() * 50);
      const colour = `color-mix(in oklch, var(--paper) ${strength}%, transparent)`;
      dots.push(`${x}px ${y}px 0 ${spread}px ${colour}`);
    }
    stars.style.boxShadow = dots.join(",");
  }

  function layField(): void {
    random = rng(seed);
    centre();
    field(5);
  }

  function resize(): void {
    if (!stage.clientWidth) return;
    width = stage.clientWidth;
    height = stage.clientHeight;
    layStars();
    if (!seeded) {
      seeded = true;
      layField();
      paint();
    } else if (state === "idle" || state === "over") {
      centre();
    }
    for (const rock of rocks) {
      wrap(rock);
      putRock(rock);
    }
    wrap(ship);
    putShip();
    if (wanted || (state === "idle" && document.activeElement === stage)) start();
  }

  stage.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      leaving = true;
      host.win.focus();
      return;
    }
    if (event.key === "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
    const pressed = event.key.toLowerCase();
    const key = KEYMAP.get(pressed);
    if (!key && !ALSO_MINE.has(pressed)) return;
    event.stopPropagation();
    event.preventDefault();
    if (state === "over" && !event.repeat) {
      start();
      return;
    }
    if (pressed === "p" && !event.repeat) {
      togglePause();
      return;
    }
    if (key) held.add(key);
  });

  stage.addEventListener("keyup", (event) => {
    const key = KEYMAP.get(event.key.toLowerCase());
    if (key) held.delete(key);
  });

  stage.addEventListener("pointerdown", () => {
    if (state === "over") start();
  });

  stage.addEventListener("blur", () => {
    held.clear();
    if (state === "play") {
      state = "pause";
      paint();
    }
  });

  stage.addEventListener("focus", () => {
    if (state === "idle") {
      start();
    } else if (state === "pause") {
      state = "play";
      paint();
    }
  });

  host.win.addEventListener("pointerdown", () => {
    pointer = true;
  });
  window.addEventListener(
    "pointerup",
    () => {
      pointer = false;
    },
    { signal: host.signal },
  );
  host.win.addEventListener("focus", () => {
    if (!leaving && !pointer && host.wide()) stage.focus({ preventScroll: true });
    leaving = false;
  });

  $$(".pad .btn", host.body).forEach((button) => {
    const key = button.dataset.k ?? "";
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (state === "play") {
        held.add(key);
        return;
      }
      if (state === "pause") state = "play";
      else start();
      paint();
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
      button.addEventListener(type, () => held.delete(key));
    }
  });

  new ResizeObserver(resize).observe(stage);

  host.onSeed((next) => {
    seed = next;
    if (!seeded) return;
    clearAll();
    layField();
    rocks.forEach(putRock);
    putShip();
    if (document.activeElement === stage) {
      start();
    } else {
      state = "idle";
      paint();
    }
  });
  paint();
  host.frame(tick);
};

export default toy;
