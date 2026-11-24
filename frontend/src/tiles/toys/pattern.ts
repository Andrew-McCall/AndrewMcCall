import "./pattern.css";
import { $ } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

type State = "idle" | "show" | "input" | "over";

const BEST_KEY = "am-pattern-best";
const TINTS = [
  "--w-about",
  "--w-projects",
  "--w-life",
  "--w-posts",
  "--w-now",
  "--w-contact",
  "--w-fetch",
  "--w-rps",
  "--w-term",
];

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <span class="tag" id="pat-hud"></span>
  </div>
  <div class="pat-wrap field"><div class="pat" id="pat"></div></div>
`;

const readBest = (): number => {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
};

const writeBest = (best: number): void => {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    return;
  }
};

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const grid = $("#pat", host.body);
  const hud = $("#pat-hud", host.body);

  let random: Rng = Math.random;
  let seed = 1;
  let sequence: number[] = [];
  let position = 0;
  let state: State = "idle";
  let run = 0;
  let best = readBest();

  const pads = TINTS.map((tint, index) => {
    const pad = document.createElement("button");
    pad.type = "button";
    pad.style.setProperty("--c", `var(${tint})`);
    pad.setAttribute("aria-label", `Pad ${index + 1}`);
    pad.addEventListener("click", () => press(index));
    grid.append(pad);
    return pad;
  });

  const flash = (index: number, ms = 240): void => {
    pads[index].classList.add("lit");
    host.later(ms, () => pads[index].classList.remove("lit"));
  };

  const say = (text: string): void => {
    hud.textContent = `${text} · best ${best}`;
  };

  const duringRun = (ms: number, action: () => void): void => {
    const me = run;
    host.later(ms, () => {
      if (me === run) action();
    });
  };

  const next = (): void => {
    sequence.push(Math.floor(random() * 9));
    state = "show";
    say(`Watch · round ${sequence.length}`);
    const gap = Math.max(250, 520 - sequence.length * 18);
    sequence.forEach((pad, step) => {
      duringRun(500 + step * gap, () => flash(pad, gap * 0.6));
    });
    duringRun(500 + sequence.length * gap, () => {
      state = "input";
      position = 0;
      say(`Your turn · round ${sequence.length}`);
    });
  };

  const start = (): void => {
    run++;
    random = rng(seed);
    sequence = [];
    grid.classList.remove("shake");
    next();
  };

  const fail = (): void => {
    state = "over";
    run++;
    const cleared = sequence.length - 1;
    if (cleared > best) {
      best = cleared;
      writeBest(best);
    }
    grid.classList.add("shake");
    say(`Wrong. ${cleared} round${cleared === 1 ? "" : "s"} cleared. Tap to retry`);
  };

  const celebrate = (): void => {
    state = "show";
    pads.forEach((_, index) => {
      duringRun(index * 35, () => flash(index, 120));
    });
    duringRun(750, next);
  };

  function press(index: number): void {
    if (state === "idle" || state === "over") {
      start();
      return;
    }
    if (state !== "input") return;
    flash(index, 160);
    if (index !== sequence[position]) {
      fail();
      return;
    }
    position++;
    if (position === sequence.length) celebrate();
  }

  host.onSeed((nextSeed) => {
    seed = nextSeed;
    run++;
    random = rng(nextSeed);
    sequence = [];
    state = "idle";
    grid.classList.remove("shake");
    say("Tap a pad to start");
  });
};

export default toy;
